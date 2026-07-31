from __future__ import annotations

import fcntl
import hashlib
import os
import subprocess
import time
import uuid
from collections.abc import AsyncIterator, Iterator
from pathlib import Path

import asyncpg
import pytest

from stripe_entitlements.catalog import PlanCatalog
from stripe_entitlements.database import _init_connection
from stripe_entitlements.processor import EventProcessor

ROOT = Path(__file__).parents[1]
TAG = hashlib.sha1(str(ROOT).encode()).hexdigest()[:8]
PG_CONTAINER = os.environ.get("TEST_PG_CONTAINER", f"stripe-entitlements-pg-{TAG}")
PG_PORT = int(os.environ.get("TEST_PG_PORT", str(56000 + int(TAG, 16) % 2000)))
PG_PASSWORD = "local-test-only"
PG_DATABASE = "stripe_entitlements_test"
TEST_DSN = f"postgresql://postgres:{PG_PASSWORD}@127.0.0.1:{PG_PORT}/{PG_DATABASE}"


def _run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, capture_output=True, text=True, **kwargs)  # type: ignore[arg-type]


def _postgres_image() -> str:
    output = _run(["docker", "images", "--format", "{{.Repository}}:{{.Tag}}"]).stdout
    for line in output.splitlines():
        if "postgres" in line and "<none>" not in line:
            return line.strip()
    return "postgres:17-alpine"


@pytest.fixture(scope="session", autouse=True)
def postgres_container() -> Iterator[None]:
    lock = Path(f"/tmp/{PG_CONTAINER}.lock").open("w")
    fcntl.flock(lock, fcntl.LOCK_EX)
    _run(["docker", "rm", "-f", PG_CONTAINER])
    started = _run(
        [
            "docker",
            "run",
            "-d",
            "--name",
            PG_CONTAINER,
            "-e",
            f"POSTGRES_PASSWORD={PG_PASSWORD}",
            "-e",
            f"POSTGRES_DB={PG_DATABASE}",
            "-p",
            f"127.0.0.1:{PG_PORT}:5432",
            _postgres_image(),
        ]
    )
    if started.returncode:
        pytest.exit(f"cannot start PostgreSQL: {started.stderr}")
    deadline = time.time() + 90
    while time.time() < deadline:
        ready = _run(
            [
                "docker",
                "exec",
                PG_CONTAINER,
                "pg_isready",
                "-h",
                "127.0.0.1",
                "-U",
                "postgres",
                "-d",
                PG_DATABASE,
            ]
        )
        if ready.returncode == 0:
            break
        time.sleep(0.25)
    else:
        _run(["docker", "rm", "-f", PG_CONTAINER])
        pytest.exit("PostgreSQL did not become ready")
    migration = "\n".join(
        path.read_text() for path in sorted((ROOT / "migrations").glob("*.sql"))
    )
    applied = subprocess.run(
        [
            "docker",
            "exec",
            "-i",
            PG_CONTAINER,
            "psql",
            "-h",
            "127.0.0.1",
            "-U",
            "postgres",
            "-d",
            PG_DATABASE,
            "-v",
            "ON_ERROR_STOP=1",
        ],
        input=migration,
        capture_output=True,
        text=True,
    )
    if applied.returncode:
        _run(["docker", "rm", "-f", PG_CONTAINER])
        pytest.exit(f"migration failed: {applied.stderr}")
    yield
    _run(["docker", "rm", "-f", PG_CONTAINER])
    fcntl.flock(lock, fcntl.LOCK_UN)
    lock.close()


@pytest.fixture
async def pool(postgres_container: None) -> AsyncIterator[asyncpg.Pool]:
    database_pool = await asyncpg.create_pool(
        TEST_DSN, min_size=1, max_size=30, init=_init_connection
    )
    async with database_pool.acquire() as conn:
        await conn.execute(
            """truncate billing_plan_changes,billing_incidents,checkout_claims,
               credit_debits,credit_ledger,
               stripe_invoice_state,stripe_webhook_events,billing_accounts
               restart identity cascade"""
        )
    yield database_pool
    await database_pool.close()


@pytest.fixture
def catalog() -> PlanCatalog:
    return PlanCatalog.from_toml(ROOT / "plans.toml", "ent")


@pytest.fixture
def processor(pool: asyncpg.Pool, catalog: PlanCatalog) -> EventProcessor:
    return EventProcessor(
        pool,
        catalog,
        "example-entitlements",
        expected_api_version="2026-06-24.dahlia",
    )


@pytest.fixture
def make_account(pool: asyncpg.Pool):
    async def _make(
        *,
        external_ref: str | None = None,
        customer: str | None = "cus_test",
        subscription: str | None = "sub_test",
    ) -> str:
        account_id = uuid.uuid4()
        plan_key = "starter" if subscription else "free"
        interval = "month" if subscription else None
        status = "active" if subscription else "none"
        async with pool.acquire() as conn:
            await conn.execute(
                """insert into billing_accounts
                     (id,external_ref,stripe_customer_id,stripe_subscription_id,
                      plan_key,plan_interval,subscription_status)
                   values($1,$2,$3,$4,$5,$6,$7)""",
                account_id,
                external_ref or f"user-{account_id}",
                customer,
                subscription,
                plan_key,
                interval,
                status,
            )
        return str(account_id)

    return _make
