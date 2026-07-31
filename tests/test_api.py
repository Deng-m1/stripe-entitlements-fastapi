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


async def test_valid_raw_signature_reaches_processor(postgres_container: None) -> None:
    root = Path(__file__).parents[1]
    secret = "whsec_local_test"
    settings = Settings(
        database_url=TEST_DSN,
        stripe_secret_key="sk_test_dummy",
        stripe_webhook_secret=secret,
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
    assert response.status_code == 200, response.text
    assert response.json()["outcome"] == "ignored"
