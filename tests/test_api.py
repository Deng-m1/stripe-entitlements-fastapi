from __future__ import annotations

import hashlib
import hmac
import json
import time
from pathlib import Path

import httpx

from stripe_entitlements.app import create_app
from stripe_entitlements.config import Settings
from stripe_entitlements.database import Database
from stripe_entitlements.stripe_gateway import StripeGateway
from tests.conftest import TEST_DSN


def _signature(payload: bytes, secret: str) -> str:
    timestamp = int(time.time())
    digest = hmac.new(
        secret.encode(), f"{timestamp}.".encode() + payload, hashlib.sha256
    ).hexdigest()
    return f"t={timestamp},v1={digest}"


async def test_webhook_rejects_invalid_signature(postgres_container: None) -> None:
    root = Path(__file__).parents[1]
    settings = Settings(
        database_url=TEST_DSN,
        stripe_secret_key="sk_test_dummy",
        stripe_webhook_secret="whsec_local_test",
        stripe_webhook_api_version="2026-06-24.dahlia",
        plan_catalog_path=str(root / "plans.toml"),
    )
    app = create_app(settings, database=Database(TEST_DSN))
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post(
                "/webhooks/stripe",
                content=b"{}",
                headers={"Stripe-Signature": "invalid"},
            )
    assert response.status_code == 400


async def test_webhook_rejects_oversized_payload_before_signature_work(
    postgres_container: None,
) -> None:
    root = Path(__file__).parents[1]
    settings = Settings(
        database_url=TEST_DSN,
        stripe_secret_key="sk_test_dummy",
        stripe_webhook_secret="whsec_local_test",
        stripe_webhook_api_version="2026-06-24.dahlia",
        plan_catalog_path=str(root / "plans.toml"),
    )
    app = create_app(settings, database=Database(TEST_DSN))
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post(
                "/webhooks/stripe",
                content=b"x" * 1_048_577,
                headers={"Stripe-Signature": "not-evaluated"},
            )
    assert response.status_code == 413


async def test_webhook_stream_limit_rejects_chunked_body_before_buffering_all_bytes(
    postgres_container: None,
) -> None:
    root = Path(__file__).parents[1]
    settings = Settings(
        database_url=TEST_DSN,
        stripe_secret_key="sk_test_dummy",
        stripe_webhook_secret="whsec_local_test",
        stripe_webhook_api_version="2026-06-24.dahlia",
        plan_catalog_path=str(root / "plans.toml"),
    )
    app = create_app(settings, database=Database(TEST_DSN))

    async def chunks():  # type: ignore[no-untyped-def]
        for _ in range(17):
            yield b"x" * 65_536

    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post(
                "/webhooks/stripe",
                content=chunks(),
                headers={"Stripe-Signature": "not-evaluated"},
            )
    assert response.status_code == 413


async def test_valid_raw_signature_reaches_processor(postgres_container: None) -> None:
    root = Path(__file__).parents[1]
    secret = "whsec_local_test"
    settings = Settings(
        database_url=TEST_DSN,
        stripe_secret_key="sk_test_dummy",
        stripe_webhook_secret=secret,
        stripe_webhook_api_version="2026-06-24.dahlia",
        plan_catalog_path=str(root / "plans.toml"),
    )
    database = Database(TEST_DSN)
    app = create_app(
        settings,
        database=database,
        gateway=StripeGateway("sk_test_dummy", secret),
    )
    payload = json.dumps(
        {
            "id": "evt_api_signature",
            "object": "event",
            "type": "customer.created",
            "created": int(time.time()),
            "livemode": False,
            "api_version": "2026-06-24.dahlia",
            "data": {"object": {"id": "cus_api", "object": "customer"}},
        },
        separators=(",", ":"),
    ).encode()
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post(
                "/webhooks/stripe",
                content=payload,
                headers={"Stripe-Signature": _signature(payload, secret)},
            )
        async with database.require_pool().acquire() as conn:
            stored_payload = await conn.fetchval(
                "select payload from stripe_webhook_events where id='evt_api_signature'"
            )
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["pragma"] == "no-cache"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.json()["outcome"] == "ignored"
    assert stored_payload["id"] == "evt_api_signature"
    assert all(not str(key).startswith("_") for key in stored_payload)


async def test_committed_webhook_duplicate_skips_remote_preparation(
    postgres_container: None,
) -> None:
    root = Path(__file__).parents[1]
    secret = "whsec_duplicate_fast_path"

    class CountingGateway(StripeGateway):
        def __init__(self) -> None:
            super().__init__("sk_test_dummy", secret)
            self.prepare_calls = 0

        async def prepare_event(self, event):  # type: ignore[no-untyped-def]
            self.prepare_calls += 1
            return await super().prepare_event(event)

    gateway = CountingGateway()
    settings = Settings(
        database_url=TEST_DSN,
        stripe_secret_key="sk_test_dummy",
        stripe_webhook_secret=secret,
        stripe_webhook_api_version="2026-06-24.dahlia",
        plan_catalog_path=str(root / "plans.toml"),
    )
    app = create_app(settings, database=Database(TEST_DSN), gateway=gateway)
    payload = json.dumps(
        {
            "id": "evt_duplicate_fast_path",
            "object": "event",
            "type": "customer.created",
            "created": int(time.time()),
            "livemode": False,
            "api_version": "2026-06-24.dahlia",
            "data": {"object": {"id": "cus_duplicate", "object": "customer"}},
        },
        separators=(",", ":"),
    ).encode()
    headers = {"Stripe-Signature": _signature(payload, secret)}

    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            first = await client.post("/webhooks/stripe", content=payload, headers=headers)
            second = await client.post("/webhooks/stripe", content=payload, headers=headers)

    assert first.status_code == 200
    assert first.json()["outcome"] == "ignored"
    assert second.status_code == 200
    assert second.json()["outcome"] == "duplicate"
    assert second.json()["reason"] == "event id already committed"
    assert gateway.prepare_calls == 1
