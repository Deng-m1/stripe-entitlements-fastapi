from __future__ import annotations

import asyncio
import json
from pathlib import Path

import httpx
import pytest

from stripe_entitlements.auth import AuthenticatedIdentity, RejectAllAuthAdapter
from stripe_entitlements.auth_starters import PersonalJwtAuthAdapter
from stripe_entitlements.config import Settings
from stripe_entitlements.database import Database
from stripe_entitlements.scheduled import (
    AnnualGrantBatchResult,
    ReconciliationBatchResult,
)
from stripe_entitlements.stripe_gateway import StripeGateway
from stripe_entitlements.vercel import (
    auth_adapter_from_environment,
    create_vercel_app,
)
from tests.conftest import TEST_DSN

ROOT = Path(__file__).parents[1]


class StaticAuth:
    async def authenticate(self, request):  # type: ignore[no-untyped-def]
        del request
        return AuthenticatedIdentity("v1:user:00000000-0000-0000-0000-000000000001")


def _settings() -> Settings:
    return Settings(
        database_url=TEST_DSN,
        stripe_secret_key="sk_test_vercel",
        stripe_webhook_secret="whsec_vercel",
        stripe_webhook_api_version="2026-06-24.dahlia",
        plan_catalog_path=str(ROOT / "plans.toml"),
    )


def test_vercel_personal_jwt_auth_is_explicit_and_fail_closed() -> None:
    assert isinstance(auth_adapter_from_environment({}), RejectAllAuthAdapter)
    with pytest.raises(ValueError, match="BILLING_AUTH_MODE"):
        auth_adapter_from_environment({"BILLING_JWT_ISSUER": "https://identity.example/"})
    with pytest.raises(ValueError, match="BILLING_JWT_AUDIENCE"):
        auth_adapter_from_environment(
            {
                "BILLING_AUTH_MODE": "personal_jwt",
                "BILLING_JWT_ISSUER": "https://identity.example/",
            }
        )
    adapter = auth_adapter_from_environment(
        {
            "BILLING_AUTH_MODE": "personal_jwt",
            "BILLING_JWT_ISSUER": "https://identity.example/",
            "BILLING_JWT_AUDIENCE": "billing-api",
            "BILLING_JWKS_URL": "https://identity.example/.well-known/jwks.json",
        }
    )
    assert isinstance(adapter, PersonalJwtAuthAdapter)


@pytest.mark.parametrize(
    "secret",
    ["short", " padded-secret-value ", "contains\nnewline", "é" * 16],
)
def test_vercel_cron_secret_rejects_unsafe_values(secret: str) -> None:
    with pytest.raises(ValueError, match="CRON_SECRET"):
        create_vercel_app(
            _settings(),
            database=Database(TEST_DSN),
            gateway=StripeGateway("sk_test_vercel", "whsec_vercel"),
            auth_adapter=StaticAuth(),
            environment={"CRON_SECRET": secret},
        )


async def test_vercel_cron_routes_require_secret_and_return_identity_free_counts(
    postgres_container: None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from stripe_entitlements import vercel

    annual_calls = 0

    async def annual(_kernel):  # type: ignore[no-untyped-def]
        nonlocal annual_calls
        annual_calls += 1
        return AnnualGrantBatchResult(3, 2, 1, 0, 0)

    async def reconcile(_kernel):  # type: ignore[no-untyped-def]
        return ReconciliationBatchResult(1, 1, 0, 0, 2, 1, 1, 0, 0)

    monkeypatch.setattr(vercel, "run_annual_grant_batch", annual)
    monkeypatch.setattr(vercel, "run_reconciliation_batch", reconcile)
    secret = "cron-secret-at-least-sixteen"
    app = create_vercel_app(
        _settings(),
        database=Database(TEST_DSN),
        gateway=StripeGateway("sk_test_vercel", "whsec_vercel"),
        auth_adapter=StaticAuth(),
        environment={"CRON_SECRET": secret},
    )
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            missing = await client.get("/api/cron/annual-grants")
            wrong = await client.get(
                "/api/cron/annual-grants",
                headers={"Authorization": "Bearer wrong-secret-value"},
            )
            granted = await client.get(
                "/api/cron/annual-grants",
                headers={"Authorization": f"Bearer {secret}"},
            )
            repaired = await client.get(
                "/api/cron/reconcile",
                headers={"Authorization": f"Bearer {secret}"},
            )

    assert missing.status_code == 401
    assert wrong.status_code == 401
    assert annual_calls == 1
    assert granted.json() == {
        "ok": True,
        "attempted": 3,
        "handled": 2,
        "replayed": 1,
        "ignored": 0,
        "failures": 0,
    }
    assert repaired.json()["packs_attempted"] == 2
    assert all("id" not in key for key in granted.json())
    assert granted.headers["cache-control"] == "no-store"


async def test_vercel_cron_without_server_secret_is_unavailable(
    postgres_container: None,
) -> None:
    app = create_vercel_app(
        _settings(),
        database=Database(TEST_DSN),
        gateway=StripeGateway("sk_test_vercel", "whsec_vercel"),
        auth_adapter=StaticAuth(),
        environment={},
    )
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.get(
                "/api/cron/reconcile",
                headers={"Authorization": "Bearer any-client-value"},
            )
    assert response.status_code == 503
    assert response.json() == {"detail": "scheduled workers are not configured"}


async def test_vercel_cron_failure_returns_retry_status_with_safe_counts(
    postgres_container: None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from stripe_entitlements import vercel

    async def annual(_kernel):  # type: ignore[no-untyped-def]
        return AnnualGrantBatchResult(2, 1, 0, 0, 1)

    monkeypatch.setattr(vercel, "run_annual_grant_batch", annual)
    secret = "retryable-cron-secret-value"
    app = create_vercel_app(
        _settings(),
        database=Database(TEST_DSN),
        gateway=StripeGateway("sk_test_vercel", "whsec_vercel"),
        auth_adapter=StaticAuth(),
        environment={"CRON_SECRET": secret},
    )
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.get(
                "/api/cron/annual-grants",
                headers={"Authorization": f"Bearer {secret}"},
            )
    assert response.status_code == 503
    assert response.json() == {
        "ok": False,
        "attempted": 2,
        "handled": 1,
        "replayed": 0,
        "ignored": 0,
        "failures": 1,
    }


async def test_concurrent_vercel_cron_invocations_are_not_process_serialized(
    postgres_container: None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from stripe_entitlements import vercel

    entered = 0
    both_entered = asyncio.Event()

    async def annual(_kernel):  # type: ignore[no-untyped-def]
        nonlocal entered
        entered += 1
        if entered == 2:
            both_entered.set()
        await asyncio.wait_for(both_entered.wait(), timeout=1)
        return AnnualGrantBatchResult(0, 0, 0, 0, 0)

    monkeypatch.setattr(vercel, "run_annual_grant_batch", annual)
    secret = "concurrent-cron-secret-value"
    app = create_vercel_app(
        _settings(),
        database=Database(TEST_DSN),
        gateway=StripeGateway("sk_test_vercel", "whsec_vercel"),
        auth_adapter=StaticAuth(),
        environment={"CRON_SECRET": secret},
    )
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            responses = await asyncio.gather(
                client.get(
                    "/api/cron/annual-grants",
                    headers={"Authorization": f"Bearer {secret}"},
                ),
                client.get(
                    "/api/cron/annual-grants",
                    headers={"Authorization": f"Bearer {secret}"},
                ),
            )
    assert entered == 2
    assert [response.status_code for response in responses] == [200, 200]


def test_vercel_services_configuration_owns_all_public_routes_and_crons() -> None:
    config = json.loads((ROOT / "vercel.json").read_text())
    assert config["services"] == {
        "frontend": {
            "root": "web/",
            "framework": "nextjs",
            "installCommand": "npm ci",
        },
        "billing": {
            "root": ".",
            "framework": "fastapi",
            "entrypoint": "vercel_app:app",
            "installCommand": "uv sync --frozen --extra auth --no-dev",
            "functions": {"vercel_app.py": {"maxDuration": 60}},
        },
    }
    assert config["rewrites"] == [
        {"source": "/api/(.*)", "destination": {"service": "billing"}},
        {"source": "/webhooks/(.*)", "destination": {"service": "billing"}},
        {"source": "/health", "destination": {"service": "billing"}},
        {"source": "/(.*)", "destination": {"service": "frontend"}},
    ]
    assert config["crons"] == [
        {"path": "/api/cron/annual-grants", "schedule": "7 * * * *"},
        {"path": "/api/cron/reconcile", "schedule": "*/5 * * * *"},
    ]
    assert "railway" not in json.dumps(config).lower()
