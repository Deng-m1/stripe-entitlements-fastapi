from __future__ import annotations

import argparse
import asyncio
import json
import os
from dataclasses import replace
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import asyncpg

from stripe_entitlements.credit_amount import CreditAmount
from stripe_entitlements.credits import CreditResult, InsufficientCreditsError
from stripe_entitlements.entitlements import (
    CreditIdempotencyConflictError,
    CreditOperationNotFoundError,
    validate_owner_external_ref,
)

from .workflow import (
    BillingOutboxWorker,
    DispatchMessage,
    DispatchOutboxWorker,
    JobWorkflowStore,
    QueueConsumer,
)

_SCHEMA_PATH = Path(__file__).with_name("schema.sql")
_TABLES = (
    "job_example_jobs",
    "job_example_attempts",
    "job_example_billing_outbox",
    "job_example_dispatch_outbox",
    "job_example_queue_inbox",
)


class DemoBillingAdapter:
    """Process-local billing double for this network-free workflow demonstration.

    Production code must inject ``EntitlementService`` or the owner-authorized internal
    billing client. This adapter exists only so the example can demonstrate the host saga
    without Stripe credentials or remote calls. It still uses exact integer atoms and
    enforces owner/amount idempotency for the lifetime of this process.
    """

    def __init__(self, owner_external_ref: str, opening_balance: str) -> None:
        self.owner_external_ref = validate_owner_external_ref(owner_external_ref)
        self.opening_balance = CreditAmount.parse(
            opening_balance,
            field="demo opening balance",
            allow_zero=False,
        )
        self._balance_atoms = self.opening_balance.atoms
        self._operations: dict[str, tuple[str, int, bool]] = {}

    @property
    def balance(self) -> CreditAmount:
        return CreditAmount.from_atoms(self._balance_atoms)

    async def charge(
        self,
        owner_external_ref: str,
        amount: str,
        idempotency_key: str,
    ) -> CreditResult:
        normalized = CreditAmount.parse(amount, field="demo charge", allow_zero=False)
        existing = self._operations.get(idempotency_key)
        if existing is not None:
            owner, atoms, _ = existing
            if owner != owner_external_ref or atoms != normalized.atoms:
                raise CreditIdempotencyConflictError("demo idempotency conflict")
            return CreditResult("replayed", self.balance, requested=normalized)
        if owner_external_ref != self.owner_external_ref:
            raise CreditIdempotencyConflictError("demo owner mismatch")
        if normalized.atoms > self._balance_atoms:
            raise InsufficientCreditsError("demo balance is insufficient")
        self._balance_atoms -= normalized.atoms
        self._operations[idempotency_key] = (
            owner_external_ref,
            normalized.atoms,
            False,
        )
        return CreditResult("charged", self.balance, requested=normalized)

    async def refund(self, owner_external_ref: str, idempotency_key: str) -> CreditResult:
        existing = self._operations.get(idempotency_key)
        if existing is None:
            raise CreditOperationNotFoundError("demo charge was not found")
        owner, atoms, refunded = existing
        if owner != owner_external_ref:
            raise CreditOperationNotFoundError("demo charge was not found")
        amount = CreditAmount.from_atoms(atoms)
        if refunded:
            return CreditResult(
                "replayed",
                self.balance,
                requested=amount,
                restored=amount,
            )
        self._balance_atoms += atoms
        self._operations[idempotency_key] = (owner, atoms, True)
        return CreditResult(
            "refunded",
            self.balance,
            requested=amount,
            restored=amount,
        )


class RecordingQueuePublisher:
    """Local queue double; the PostgreSQL dispatch outbox remains authoritative."""

    def __init__(self) -> None:
        self.messages: list[DispatchMessage] = []

    async def publish(self, message: DispatchMessage) -> None:
        self.messages.append(message)


async def ensure_example_schema(pool: asyncpg.Pool) -> str:
    """Create the example schema once, refuse an ambiguous partial installation."""

    async with pool.acquire() as connection:
        present = {
            name
            for name in _TABLES
            if await connection.fetchval("select to_regclass($1) is not null", name)
        }
        if present == set(_TABLES):
            return "existing"
        if present:
            raise RuntimeError("the Job example schema is only partially installed")
        await connection.execute(_SCHEMA_PATH.read_text(encoding="utf-8"))
    return "created"


async def _cleanup_run(pool: asyncpg.Pool, job_ids: list[UUID]) -> bool:
    if not job_ids:
        return True
    async with pool.acquire() as connection, connection.transaction():
        await connection.execute(
            """delete from job_example_queue_inbox q
                using job_example_dispatch_outbox d
                where q.dispatch_id=d.id and d.job_id=any($1::uuid[])""",
            job_ids,
        )
        await connection.execute(
            "delete from job_example_dispatch_outbox where job_id=any($1::uuid[])",
            job_ids,
        )
        await connection.execute(
            "delete from job_example_billing_outbox where job_id=any($1::uuid[])",
            job_ids,
        )
        await connection.execute(
            "delete from job_example_attempts where job_id=any($1::uuid[])",
            job_ids,
        )
        await connection.execute(
            "delete from job_example_jobs where id=any($1::uuid[])",
            job_ids,
        )
        remaining = await connection.fetchval(
            "select count(*) from job_example_jobs where id=any($1::uuid[])",
            job_ids,
        )
    return int(remaining) == 0


async def run_demo(
    pool: asyncpg.Pool,
    *,
    keep_rows: bool = False,
) -> dict[str, Any]:
    """Run success and terminal-failure/refund paths against real PostgreSQL."""

    run_id = uuid4().hex
    owner = f"v1:demo-job:{run_id}"
    store = JobWorkflowStore(pool)
    billing = DemoBillingAdapter(owner, "5.000003")
    billing_worker = BillingOutboxWorker(store, billing, retry_seconds=0)
    publisher = RecordingQueuePublisher()
    dispatch_worker = DispatchOutboxWorker(store, publisher, retry_seconds=0)
    consumer = QueueConsumer(store, execution_lease_seconds=30)
    job_ids: list[UUID] = []
    result: dict[str, Any] | None = None
    cleanup_ok = False

    try:
        successful = await store.submit_job(
            request_key=f"demo:{run_id}:success",
            owner_external_ref=owner,
            amount="1.250001",
            payload={"input_key": "success.pdf", "scenario": "success"},
        )
        failed = await store.submit_job(
            request_key=f"demo:{run_id}:failure",
            owner_external_ref=owner,
            amount="0.750002",
            payload={"input_key": "failure.pdf", "scenario": "failure"},
        )
        job_ids.extend((successful.job_id, failed.job_id))
        replay = await store.submit_job(
            request_key=f"demo:{run_id}:success",
            owner_external_ref=owner,
            amount="1.250001",
            payload={"input_key": "success.pdf", "scenario": "success"},
        )
        if replay.created or replay.job_id != successful.job_id:
            raise RuntimeError("same request key did not replay the original Job")

        charge_outcomes = await billing_worker.run_once(limit=10)
        dispatch_outcomes = await dispatch_worker.run_once(limit=10)
        if charge_outcomes != ["completed", "completed"]:
            raise RuntimeError("demo charge outbox did not converge")
        if dispatch_outcomes != ["published", "published"]:
            raise RuntimeError("demo dispatch outbox did not converge")

        queue_outcomes: list[str] = []
        stale_execution_tokens_rejected: list[bool] = []
        for message in publisher.messages:
            outcome, execution = await consumer.consume(message)
            queue_outcomes.append(outcome)
            if outcome != "started" or execution is None:
                raise RuntimeError("demo queue message did not start an execution")
            stale_execution = replace(execution, execution_token=uuid4())
            if execution.payload.get("scenario") == "success":
                stale_rejected = not await store.complete_execution(stale_execution)
                completed = await store.complete_execution(execution)
            else:
                stale_rejected = not await store.fail_execution(
                    stale_execution,
                    reason="demo_terminal_failure",
                )
                completed = await store.fail_execution(
                    execution,
                    reason="demo_terminal_failure",
                )
            stale_execution_tokens_rejected.append(stale_rejected)
            if not stale_rejected or not completed:
                raise RuntimeError("execution fencing did not reject stale authority")
            duplicate_outcome, duplicate_execution = await consumer.consume(message)
            if duplicate_outcome != "duplicate" or duplicate_execution is not None:
                raise RuntimeError("queue inbox did not deduplicate a repeated delivery")

        refund_outcomes = await billing_worker.run_once(limit=10)
        if refund_outcomes != ["completed"]:
            raise RuntimeError("demo refund outbox did not converge")
        if await billing_worker.run_once(limit=10):
            raise RuntimeError("a completed demo outbox was claimed again")

        async with pool.acquire() as connection:
            rows = await connection.fetch(
                """select j.id,j.state as job_state,a.state as attempt_state
                     from job_example_jobs j
                     join job_example_attempts a on a.job_id=j.id
                    where j.id=any($1::uuid[]) order by j.request_key""",
                job_ids,
            )
            outbox_rows = await connection.fetch(
                """select operation,state,result_outcome,count(*) as entries
                     from job_example_billing_outbox
                    where job_id=any($1::uuid[])
                    group by operation,state,result_outcome
                    order by operation,result_outcome""",
                job_ids,
            )

        state_by_id = {
            str(row["id"]): {
                "job": str(row["job_state"]),
                "attempt": str(row["attempt_state"]),
            }
            for row in rows
        }
        result = {
            "ok": True,
            "network_calls": 0,
            "billing_adapter": "DemoBillingAdapter (process-local, not for production)",
            "credit_protocol": {
                "scale": 1_000_000,
                "opening": str(billing.opening_balance),
                "opening_atoms": str(billing.opening_balance.atoms),
                "final": str(billing.balance),
                "final_atoms": str(billing.balance.atoms),
            },
            "idempotent_submission_replayed": not replay.created,
            "charge_outcomes": charge_outcomes,
            "dispatch_outcomes": dispatch_outcomes,
            "queue_outcomes": queue_outcomes,
            "stale_execution_tokens_rejected": all(stale_execution_tokens_rejected),
            "jobs": {
                "success": state_by_id[str(successful.job_id)],
                "failure": state_by_id[str(failed.job_id)],
            },
            "billing_outbox": [
                {
                    "operation": str(row["operation"]),
                    "state": str(row["state"]),
                    "outcome": str(row["result_outcome"]),
                    "entries": int(row["entries"]),
                }
                for row in outbox_rows
            ],
            "cleanup": {"requested": not keep_rows, "completed": False},
        }
    finally:
        if keep_rows:
            cleanup_ok = False
        else:
            cleanup_ok = await _cleanup_run(pool, job_ids)
        if result is not None:
            result["cleanup"]["completed"] = cleanup_ok

    assert result is not None
    return result


async def _main_async(database_url: str, *, apply_schema: bool, keep_rows: bool) -> dict[str, Any]:
    pool = await asyncpg.create_pool(database_url, min_size=1, max_size=4)
    try:
        schema = await ensure_example_schema(pool) if apply_schema else "not-requested"
        result = await run_demo(pool, keep_rows=keep_rows)
        result["schema"] = schema
        return result
    finally:
        await pool.close()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Run the network-free Job/outbox/fencing PostgreSQL demonstration"
    )
    parser.add_argument(
        "--database-url",
        default=os.environ.get("JOB_EXAMPLE_DATABASE_URL") or os.environ.get("DATABASE_URL"),
        help="PostgreSQL DSN; defaults to JOB_EXAMPLE_DATABASE_URL or DATABASE_URL",
    )
    parser.add_argument(
        "--apply-schema",
        action="store_true",
        help="create the host-owned example tables when none of them exist",
    )
    parser.add_argument(
        "--keep-rows",
        action="store_true",
        help="retain only this run's rows for local inspection",
    )
    args = parser.parse_args()
    if not args.database_url:
        parser.error("a PostgreSQL URL is required")
    report = asyncio.run(
        _main_async(
            args.database_url,
            apply_schema=args.apply_schema,
            keep_rows=args.keep_rows,
        )
    )
    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
