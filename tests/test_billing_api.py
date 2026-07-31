from __future__ import annotations

from collections.abc import AsyncIterator
from datetime import UTC, datetime
from pathlib import Path

import httpx
import pytest

from stripe_entitlements.app import create_app
from stripe_entitlements.auth import AuthenticatedIdentity
from stripe_entitlements.config import Settings
from stripe_entitlements.database import Database
from stripe_entitlements.plan_changes import (
    PlanChangeContext,
    PlanChangeEstimate,
    RemotePlanChange,
)
from tests.conftest import TEST_DSN


@pytest.fixture(autouse=True)
async def _reset_database(pool) -> AsyncIterator[None]:  # type: ignore[no-untyped-def]
    # The ASGI tests open their own Database pool; depend on the shared fixture so
    # every test still receives a clean migrated PostgreSQL state.
    yield


class StaticAuth:
    async def authenticate(self, request):  # type: ignore[no-untyped-def]
        del request
        return AuthenticatedIdentity("api-user", "api-user@example.test")


class FakeBillingGateway:
    def __init__(self) -> None:
        self.checkout_kwargs = None
        self.portal_keys: list[str] = []
        self.apply_calls = 0

    async def create_checkout_session(self, **kwargs):  # type: ignore[no-untyped-def]
        self.checkout_kwargs = kwargs
        return "cs_api", "https://checkout.test/api"

    async def create_portal_session(
        self, *, customer_id: str, idempotency_key: str
    ) -> tuple[str, str]:
        assert customer_id == "cus_api"
        self.portal_keys.append(idempotency_key)
        return "bps_api", "https://billing.stripe.test/session"

    async def prepare_plan_change(
        self,
        subscription_id: str,
        target_lookup_key: str,
        **kwargs,  # type: ignore[no-untyped-def]
    ) -> PlanChangeContext:
        del kwargs
        return PlanChangeContext(
            subscription_id,
            "si_api",
            "price_starter_month",
            "ent_starter_month",
            f"price_{target_lookup_key}",
            "year" if target_lookup_key.endswith("_year") else "month",
            datetime(2026, 7, 1, tzinfo=UTC),
            datetime(2026, 8, 1, tzinfo=UTC),
            None,
        )

    async def preview_immediate_plan_change(
        self, context: PlanChangeContext
    ) -> PlanChangeEstimate:
        del context
        return PlanChangeEstimate(4900, 0, 0, "usd", True)

    async def apply_immediate_plan_change(
        self,
        context: PlanChangeContext,
        *,
        idempotency_key: str,
    ) -> RemotePlanChange:
        del context, idempotency_key
        self.apply_calls += 1
        return RemotePlanChange("sub_api")

    async def schedule_plan_change(
        self, context: PlanChangeContext, *, idempotency_key: str
    ) -> RemotePlanChange:
        del context, idempotency_key
        return RemotePlanChange("sub_sched_api")

    def construct_event(self, payload: bytes, signature: str):  # type: ignore[no-untyped-def]
        del payload, signature
        raise AssertionError("webhook not used")


def _settings() -> Settings:
    return Settings(
        database_url=TEST_DSN,
        stripe_secret_key="sk_test_dummy",
        stripe_webhook_secret="whsec_local_test",
        stripe_portal_configuration_id="bpc_test",
        plan_catalog_path=str(Path(__file__).parents[1] / "plans.toml"),
    )


async def test_default_auth_is_fail_closed(postgres_container: None) -> None:
    app = create_app(_settings(), database=Database(TEST_DSN), gateway=FakeBillingGateway())  # type: ignore[arg-type]
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.get("/api/catalog")
    assert response.status_code == 401


async def test_http_contract_catalog_account_checkout_and_portal(
    postgres_container: None,
) -> None:
    gateway = FakeBillingGateway()
    database = Database(TEST_DSN)
    app = create_app(
        _settings(),
        database=database,
        gateway=gateway,  # type: ignore[arg-type]
        auth_adapter=StaticAuth(),
    )
    headers = {"Authorization": "Bearer ignored", "Idempotency-Key": "request-1"}
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            catalog = await client.get("/api/catalog", headers=headers)
            account = await client.get("/api/account", headers=headers)
            checkout = await client.post(
                "/api/checkout",
                headers=headers,
                json={
                    "plan_key": "starter",
                    "interval": "month",
                    "success_url": (
                        "http://localhost:3000/billing/success?"
                        "expected_plan=starter&expected_interval=month"
                    ),
                    "cancel_url": "http://localhost:3000/pricing",
                },
            )
            invalid_redirect = await client.post(
                "/api/checkout",
                headers={**headers, "Idempotency-Key": "request-2"},
                json={
                    "plan_key": "starter",
                    "interval": "month",
                    "success_url": "https://attacker.invalid/steal",
                    "cancel_url": "http://localhost:3000/pricing",
                },
            )
            local = await database.account_for_external_ref("api-user")
            async with database.require_pool().acquire() as conn:
                await conn.execute(
                    "update billing_accounts set stripe_customer_id='cus_api' where id=$1",
                    local["id"],
                )
            portal = await client.post(
                "/api/billing/portal",
                headers={**headers, "Idempotency-Key": "portal-1"},
                json={"return_url": "http://localhost:3000/account"},
            )
    assert catalog.status_code == 200
    first = catalog.json()["plans"][0]
    assert set(first) >= {"name", "description", "display_order", "prices", "entitlements"}
    assert first["prices"]["month"]["unit_amount"] == 1900
    entitlements = {item["key"]: item for item in first["entitlements"]}
    assert entitlements["monthly_credits"] == {
        "key": "monthly_credits",
        "label": "Credits per monthly grant",
        "value": 300,
        "unit": "credits",
    }
    assert entitlements["pdf_to_ppt"]["label"] == "PDF to PowerPoint"
    assert entitlements["max_file_mb"]["unit"] == "MB"
    assert entitlements["max_pages_per_job"]["unit"] == "pages"
    assert account.json()["plan_key"] == "free"
    assert checkout.json() == {"url": "https://checkout.test/api"}
    assert gateway.checkout_kwargs["plan_key"] == "starter"
    assert invalid_redirect.status_code == 400
    assert portal.json() == {"url": "https://billing.stripe.test/session"}


async def test_http_preview_confirm_contract(postgres_container: None) -> None:
    gateway = FakeBillingGateway()
    database = Database(TEST_DSN)
    app = create_app(
        _settings(),
        database=database,
        gateway=gateway,  # type: ignore[arg-type]
        auth_adapter=StaticAuth(),
    )
    headers = {"Authorization": "Bearer ignored", "Idempotency-Key": "preview-http-1"}
    async with app.router.lifespan_context(app):
        account = await database.account_for_external_ref("api-user")
        period_end = datetime(2026, 8, 1, tzinfo=UTC)
        async with database.require_pool().acquire() as conn:
            await conn.execute(
                """update billing_accounts set stripe_customer_id='cus_api',
                     stripe_subscription_id='sub_api',plan_key='starter',plan_interval='month',
                     subscription_status='active',current_period_end=$2,
                     entitlement_period_end=$2,credit_expires_at=$2
                     where id=$1""",
                account["id"],
                period_end,
            )
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            preview = await client.post(
                "/api/billing/change/preview",
                headers=headers,
                json={"plan_key": "pro", "interval": "month"},
            )
            body = preview.json()
            confirm = await client.post(
                "/api/billing/change/confirm",
                headers={"Authorization": "Bearer ignored"},
                json={"preview_id": body["preview_id"]},
            )
    assert preview.status_code == 200, preview.text
    assert body["amount_due_now"] == 4900
    assert body["credit_applied"] == 0
    assert body["next_invoice_amount"] == 4900
    assert confirm.status_code == 200, confirm.text
    assert confirm.json()["status"] == "confirmed"
    assert gateway.apply_calls == 1


async def test_http_confirm_rejects_expired_preview_and_requires_new_intent(
    postgres_container: None,
) -> None:
    gateway = FakeBillingGateway()
    database = Database(TEST_DSN)
    app = create_app(
        _settings(),
        database=database,
        gateway=gateway,  # type: ignore[arg-type]
        auth_adapter=StaticAuth(),
    )
    headers = {
        "Authorization": "Bearer ignored",
        "Idempotency-Key": "expired-http-preview",
    }
    async with app.router.lifespan_context(app):
        account = await database.account_for_external_ref("api-user")
        period_end = datetime(2026, 8, 1, tzinfo=UTC)
        async with database.require_pool().acquire() as conn:
            await conn.execute(
                """update billing_accounts set stripe_customer_id='cus_api',
                     stripe_subscription_id='sub_api',plan_key='starter',plan_interval='month',
                     subscription_status='active',current_period_end=$2,
                     entitlement_period_end=$2,credit_expires_at=$2
                     where id=$1""",
                account["id"],
                period_end,
            )
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            preview = await client.post(
                "/api/billing/change/preview",
                headers=headers,
                json={"plan_key": "pro", "interval": "month"},
            )
            preview_id = preview.json()["preview_id"]
            async with database.require_pool().acquire() as conn:
                await conn.execute(
                    """update billing_plan_changes
                         set preview_expires_at=now()-interval '1 second'
                         where id=$1::uuid""",
                    preview_id,
                )
            confirm = await client.post(
                "/api/billing/change/confirm",
                headers={"Authorization": "Bearer ignored"},
                json={"preview_id": preview_id},
            )
            reused = await client.post(
                "/api/billing/change/preview",
                headers=headers,
                json={"plan_key": "pro", "interval": "month"},
            )

    assert preview.status_code == 200
    assert confirm.status_code == 409
    assert "preview expired" in confirm.json()["detail"]
    assert reused.status_code == 409
    assert "new intent" in reused.json()["detail"]
    assert gateway.apply_calls == 0
