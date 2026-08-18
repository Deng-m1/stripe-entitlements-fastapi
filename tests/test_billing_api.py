from __future__ import annotations

from collections.abc import AsyncIterator
from datetime import UTC, datetime
from pathlib import Path

import httpx
import pytest

from stripe_entitlements.app import create_app
from stripe_entitlements.auth import AuthenticatedIdentity, AuthenticationError
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


class SecretFailAuth:
    async def authenticate(self, request):  # type: ignore[no-untyped-def]
        del request
        raise AuthenticationError("identity-provider-secret-detail")


class IdentityAuth:
    def __init__(self, external_ref: str, email: str | None = None) -> None:
        self.identity = AuthenticatedIdentity(external_ref, email)

    async def authenticate(self, request):  # type: ignore[no-untyped-def]
        del request
        return self.identity


class FakeBillingGateway:
    def __init__(self) -> None:
        self.secret_key = "sk_test_fake_billing_gateway"
        self.checkout_kwargs = None
        self.portal_keys: list[str] = []
        self.apply_calls = 0
        self.last_apply_kwargs = None

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
            datetime(2030, 8, 1, tzinfo=UTC),
            None,
        )

    async def preview_immediate_plan_change(
        self,
        context: PlanChangeContext,
        **kwargs,  # type: ignore[no-untyped-def]
    ) -> PlanChangeEstimate:
        if kwargs.get("policy") == "prorated_delta":
            proration_date = int(kwargs["proration_date"])
            return PlanChangeEstimate(
                1500,
                950,
                0,
                "usd",
                True,
                950,
                2450,
                0,
                0,
                datetime.fromtimestamp(proration_date, tz=UTC),
                context.current_period_end,
            )
        return PlanChangeEstimate(4900, 0, 0, "usd", True)

    async def apply_immediate_plan_change(
        self,
        context: PlanChangeContext,
        *,
        idempotency_key: str,
        **kwargs,  # type: ignore[no-untyped-def]
    ) -> RemotePlanChange:
        del context, idempotency_key
        self.last_apply_kwargs = kwargs
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
        stripe_webhook_api_version="2026-06-24.dahlia",
        stripe_portal_configuration_id="bpc_test",
        plan_catalog_path=str(Path(__file__).parents[1] / "plans.toml"),
    )


def test_live_mode_rejects_non_https_public_urls() -> None:
    settings = _settings().model_copy(update={"stripe_secret_key": "sk_live_dummy"})
    gateway = FakeBillingGateway()
    gateway.secret_key = "sk_live_fake_billing_gateway"
    with pytest.raises(ValueError, match="HTTPS URL"):
        create_app(settings, database=Database(TEST_DSN), gateway=gateway)  # type: ignore[arg-type]


def test_credentialed_cors_rejects_wildcard_origin() -> None:
    settings = _settings().model_copy(update={"frontend_origins": "*"})
    with pytest.raises(ValueError, match="wildcard origin"):
        create_app(
            settings,
            database=Database(TEST_DSN),
            gateway=FakeBillingGateway(),  # type: ignore[arg-type]
        )


def test_cors_origin_with_path_fails_at_startup() -> None:
    settings = _settings().model_copy(
        update={"frontend_origins": "http://localhost:3000/not-an-origin"}
    )
    with pytest.raises(ValueError, match="bare HTTP"):
        create_app(
            settings,
            database=Database(TEST_DSN),
            gateway=FakeBillingGateway(),  # type: ignore[arg-type]
        )


async def test_state_changing_billing_request_rejects_untrusted_browser_origin(
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
    payload = {
        "plan_key": "starter",
        "interval": "month",
        "success_url": "http://localhost:3000/billing/success",
        "cancel_url": "http://localhost:3000/pricing",
    }
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            rejected = await client.post(
                "/api/checkout",
                headers={
                    "Authorization": "Bearer ignored",
                    "Idempotency-Key": "csrf-rejected",
                    "Origin": "https://attacker.example",
                },
                json=payload,
            )
            allowed = await client.post(
                "/api/checkout",
                headers={
                    "Authorization": "Bearer ignored",
                    "Idempotency-Key": "csrf-allowed",
                    "Origin": "http://localhost:3000",
                },
                json=payload,
            )
        async with database.require_pool().acquire() as conn:
            account_count = await conn.fetchval("select count(*) from billing_accounts")
    assert rejected.status_code == 403
    assert rejected.json() == {"error": "request origin is not allowed"}
    assert rejected.headers["cache-control"] == "no-store"
    assert allowed.status_code == 200
    assert account_count == 1
    assert gateway.checkout_kwargs is not None


async def test_stripe_webhook_is_exempt_from_browser_origin_guard(
    postgres_container: None,
) -> None:
    app = create_app(_settings(), database=Database(TEST_DSN))
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.post(
                "/webhooks/stripe",
                headers={
                    "Origin": "https://attacker.example",
                    "Stripe-Signature": "invalid",
                },
                content=b"{}",
            )
    assert response.status_code == 400
    assert response.json() == {"error": "invalid Stripe signature"}


def test_invalid_webhook_secret_fails_at_startup() -> None:
    settings = _settings().model_copy(update={"stripe_webhook_secret": "not-a-secret"})
    with pytest.raises(ValueError, match="whsec_"):
        create_app(
            settings,
            database=Database(TEST_DSN),
            gateway=FakeBillingGateway(),  # type: ignore[arg-type]
        )


def test_injected_gateway_mode_must_match_settings() -> None:
    settings = _settings().model_copy(update={"stripe_secret_key": "sk_live_dummy"})
    with pytest.raises(ValueError, match="modes do not match"):
        create_app(settings, database=Database(TEST_DSN), gateway=FakeBillingGateway())  # type: ignore[arg-type]


def test_settings_reject_non_secret_stripe_key_even_with_injected_gateway() -> None:
    settings = _settings().model_copy(update={"stripe_secret_key": "rk_test_not_supported"})
    with pytest.raises(ValueError, match="configured Stripe key"):
        create_app(
            settings,
            database=Database(TEST_DSN),
            gateway=FakeBillingGateway(),  # type: ignore[arg-type]
        )


async def test_lifespan_does_not_close_a_host_owned_database_pool(
    postgres_container: None,
) -> None:
    database = Database(TEST_DSN)
    await database.connect()
    original_pool = database.require_pool()
    app = create_app(
        _settings(),
        database=database,
        gateway=FakeBillingGateway(),  # type: ignore[arg-type]
    )
    try:
        async with app.router.lifespan_context(app):
            assert database.require_pool() is original_pool
        assert database.require_pool() is original_pool
        async with original_pool.acquire() as conn:
            assert await conn.fetchval("select 1") == 1
    finally:
        await database.close()


async def test_authentication_failure_does_not_expose_adapter_error_detail(
    postgres_container: None,
) -> None:
    app = create_app(
        _settings(),
        database=Database(TEST_DSN),
        gateway=FakeBillingGateway(),  # type: ignore[arg-type]
        auth_adapter=SecretFailAuth(),
    )
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.get("/api/account")
    assert response.status_code == 401
    assert response.json() == {"detail": "authentication failed"}
    assert "identity-provider-secret-detail" not in response.text


async def test_default_auth_is_fail_closed(postgres_container: None) -> None:
    app = create_app(_settings(), database=Database(TEST_DSN), gateway=FakeBillingGateway())  # type: ignore[arg-type]
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.get("/api/catalog")
    assert response.status_code == 401


@pytest.mark.parametrize(
    ("external_ref", "email"),
    [
        (" padded-subject ", None),
        ("delete\x7f", None),
        ("zero\u200bwidth", None),
        ("x" * 513, None),
        ("valid-subject", "x" * 321),
        ("valid-subject", " padded@example.test "),
        ("valid-subject", "missing-at.example.test"),
        ("valid-subject", "two@@example.test"),
        ("valid-subject", "has space@example.test"),
        ("valid-subject", "zero\u200bwidth@example.test"),
    ],
)
async def test_invalid_authenticated_identity_is_rejected_before_account_write(
    external_ref: str, email: str | None, postgres_container: None
) -> None:
    database = Database(TEST_DSN)
    app = create_app(
        _settings(),
        database=database,
        gateway=FakeBillingGateway(),  # type: ignore[arg-type]
        auth_adapter=IdentityAuth(external_ref, email),
    )
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.get("/api/account")
        async with database.require_pool().acquire() as conn:
            account_count = await conn.fetchval("select count(*) from billing_accounts")
    assert response.status_code == 401
    assert account_count == 0


async def test_checkout_test_mode_requirement_rejects_live_before_account_write(
    postgres_container: None,
) -> None:
    settings = _settings().model_copy(
        update={
            "stripe_secret_key": "sk_live_dummy",
            "checkout_success_url": "https://app.example/billing/success",
            "checkout_cancel_url": "https://app.example/pricing",
            "portal_return_url": "https://app.example/account",
            "frontend_origins": "https://app.example",
        }
    )
    gateway = FakeBillingGateway()
    gateway.secret_key = "sk_live_fake_billing_gateway"
    database = Database(TEST_DSN)
    app = create_app(
        settings,
        database=database,
        gateway=gateway,  # type: ignore[arg-type]
        auth_adapter=StaticAuth(),
    )
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            health = await client.get("/health")
            response = await client.post(
                "/api/checkout",
                headers={
                    "Authorization": "Bearer ignored",
                    "Idempotency-Key": "live-refusal",
                    "X-Stripe-Mode-Requirement": "test",
                },
                json={
                    "plan_key": "starter",
                    "interval": "month",
                    "success_url": "http://localhost:3000/billing/success",
                    "cancel_url": "http://localhost:3000/pricing",
                },
            )
        async with database.require_pool().acquire() as conn:
            account_count = await conn.fetchval(
                "select count(*) from billing_accounts where external_ref='api-user'"
            )

    assert health.json()["stripe_mode"] == "live"
    assert health.headers["cache-control"] == "no-store"
    assert response.status_code == 409
    assert account_count == 0
    assert gateway.checkout_kwargs is None


async def test_health_returns_503_when_schema_is_not_ready(
    postgres_container: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    database = Database(TEST_DSN)
    app = create_app(
        _settings(),
        database=database,
        gateway=FakeBillingGateway(),  # type: ignore[arg-type]
        auth_adapter=StaticAuth(),
    )

    async def not_ready() -> bool:
        return False

    monkeypatch.setattr(database, "schema_ready", not_ready)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.get("/health")
    assert response.status_code == 503
    assert response.headers["cache-control"] == "no-store"
    assert response.json() == {
        "ok": False,
        "database": True,
        "schema": False,
        "stripe_mode": "test",
        "transition_policy": "full_period_reset",
    }


async def test_checkout_invalid_remote_identity_returns_retryable_error_and_keeps_claim(
    postgres_container: None,
) -> None:
    class InvalidCheckoutGateway(FakeBillingGateway):
        async def create_checkout_session(self, **kwargs):  # type: ignore[no-untyped-def]
            self.checkout_kwargs = kwargs
            return "cs_invalid", "http://checkout.invalid/session"

    gateway = InvalidCheckoutGateway()
    database = Database(TEST_DSN)
    app = create_app(
        _settings(),
        database=database,
        gateway=gateway,  # type: ignore[arg-type]
        auth_adapter=StaticAuth(),
    )
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.post(
                "/api/checkout",
                headers={
                    "Authorization": "Bearer ignored",
                    "Idempotency-Key": "invalid-remote-session",
                },
                json={
                    "plan_key": "starter",
                    "interval": "month",
                    "success_url": "http://localhost:3000/billing/success",
                    "cancel_url": "http://localhost:3000/pricing",
                },
            )
        async with database.require_pool().acquire() as conn:
            claim = await conn.fetchrow("select client_request_key,session_id from checkout_claims")
    assert response.status_code == 502
    assert "retry the same request" in response.json()["detail"]
    assert claim is not None and tuple(claim) == ("invalid-remote-session", None)


async def test_account_entitlements_fail_closed_without_database_clock(
    monkeypatch: pytest.MonkeyPatch,
    postgres_container: None,
) -> None:
    database = Database(TEST_DSN)
    app = create_app(
        _settings(),
        database=database,
        gateway=FakeBillingGateway(),  # type: ignore[arg-type]
        auth_adapter=StaticAuth(),
    )
    async with app.router.lifespan_context(app):
        account = await database.account_for_external_ref("api-user")
        async with database.require_pool().acquire() as conn:
            await conn.execute(
                """update billing_accounts set plan_key='starter',plan_interval='month',
                       subscription_status='active',entitlement_revoked=false,
                       credits_balance=300,credit_expires_at=now()+interval '1 hour'
                     where id=$1::uuid""",
                account["id"],
            )
        snapshot = await database.account(str(account["id"]))
        assert snapshot is not None
        snapshot.pop("database_now")

        async def without_database_clock(external_ref: str) -> dict[str, object]:
            assert external_ref == "api-user"
            return snapshot

        monkeypatch.setattr(database, "account_for_external_ref", without_database_clock)
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.get("/api/account", headers={"Authorization": "Bearer ignored"})
    assert response.status_code == 200
    assert response.json()["entitlements_enforceable"] is False


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
            health = await client.get("/health")
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
    assert health.json() == {
        "ok": True,
        "database": True,
        "stripe_mode": "test",
        "transition_policy": "full_period_reset",
    }
    assert catalog.json()["transition_policy"] == "full_period_reset"
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
    for response in (catalog, account, checkout, invalid_redirect, portal):
        assert response.headers["cache-control"] == "no-store"
        assert response.headers["pragma"] == "no-cache"
        assert response.headers["x-content-type-options"] == "nosniff"
    assert checkout.json() == {"url": "https://checkout.test/api"}
    assert gateway.checkout_kwargs["plan_key"] == "starter"
    assert invalid_redirect.status_code == 400
    assert portal.json() == {"url": "https://billing.stripe.test/session"}


async def test_http_rejects_malformed_intent_and_redirect_inputs(
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
    base_headers = {"Authorization": "Bearer ignored"}
    valid_checkout = {
        "plan_key": "starter",
        "interval": "month",
        "success_url": "http://localhost:3000/billing/success",
        "cancel_url": "http://localhost:3000/pricing",
    }
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            duplicate_query = await client.post(
                "/api/checkout",
                headers={**base_headers, "Idempotency-Key": "duplicate-query"},
                json={
                    **valid_checkout,
                    "success_url": (
                        "http://localhost:3000/billing/success?"
                        "expected_plan=starter&expected_plan=starter&"
                        "expected_interval=month"
                    ),
                },
            )
            padded_key = await client.post(
                "/api/checkout",
                headers={**base_headers, "Idempotency-Key": " padded "},
                json=valid_checkout,
            )
            too_long_key = await client.post(
                "/api/checkout",
                headers={**base_headers, "Idempotency-Key": "x" * 201},
                json=valid_checkout,
            )
            unknown_plan = await client.post(
                "/api/checkout",
                headers={**base_headers, "Idempotency-Key": "unknown-plan"},
                json={**valid_checkout, "plan_key": "enterprise"},
            )
            malformed_preview = await client.post(
                "/api/billing/change/confirm",
                headers=base_headers,
                json={"preview_id": "not-a-uuid"},
            )
            unknown_field = await client.post(
                "/api/checkout",
                headers={**base_headers, "Idempotency-Key": "unknown-field"},
                json={**valid_checkout, "client_controls_entitlements": True},
            )
            invalid_portal = await client.post(
                "/api/billing/portal",
                headers={**base_headers, "Idempotency-Key": "invalid-portal"},
                json={"return_url": "https://attacker.example/return"},
            )
            unknown_preview_plan = await client.post(
                "/api/billing/change/preview",
                headers={**base_headers, "Idempotency-Key": "unknown-preview-plan"},
                json={"plan_key": "enterprise", "interval": "month"},
            )
        async with database.require_pool().acquire() as conn:
            account_count = await conn.fetchval("select count(*) from billing_accounts")
    assert duplicate_query.status_code == 400
    assert "duplicate" in duplicate_query.json()["detail"]
    assert padded_key.status_code == 400
    assert too_long_key.status_code == 400
    assert unknown_plan.status_code == 400
    assert malformed_preview.status_code == 422
    assert unknown_field.status_code == 422
    assert invalid_portal.status_code == 400
    assert unknown_preview_plan.status_code == 400
    assert account_count == 0
    assert gateway.checkout_kwargs is None
    assert gateway.apply_calls == 0


async def test_invalid_checkout_inputs_do_not_create_billing_account(
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
    valid = {
        "plan_key": "starter",
        "interval": "month",
        "success_url": "http://localhost:3000/billing/success",
        "cancel_url": "http://localhost:3000/pricing",
    }
    cases = [
        ({"Idempotency-Key": " padded "}, valid),
        ({"Idempotency-Key": "unknown-plan"}, {**valid, "plan_key": "enterprise"}),
        (
            {"Idempotency-Key": "bad-success"},
            {**valid, "success_url": "https://attacker.example/steal"},
        ),
        (
            {"Idempotency-Key": "bad-cancel"},
            {**valid, "cancel_url": "https://attacker.example/cancel"},
        ),
    ]
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            responses = [
                await client.post(
                    "/api/checkout",
                    headers={"Authorization": "Bearer ignored", **headers},
                    json=payload,
                )
                for headers, payload in cases
            ]
        async with database.require_pool().acquire() as conn:
            account_count = await conn.fetchval("select count(*) from billing_accounts")
    assert all(response.status_code == 400 for response in responses)
    assert account_count == 0
    assert gateway.checkout_kwargs is None


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
        period_end = datetime(2030, 8, 1, tzinfo=UTC)
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
            catalog_response = await client.get(
                "/api/catalog", headers={"Authorization": "Bearer ignored"}
            )
            account_response = await client.get(
                "/api/account", headers={"Authorization": "Bearer ignored"}
            )
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
    assert catalog_response.json()["transition_policy"] == "full_period_reset"
    assert account_response.json()["transition_policy"] == "full_period_reset"
    assert body["amount_due_now"] == 4900
    assert body["credit_applied"] == 0
    assert body["next_invoice_amount"] == 4900
    assert body["transition_policy"] == "full_period_reset"
    assert body["settlement_mode"] == "new_period_full_price"
    assert confirm.status_code == 200, confirm.text
    assert confirm.json()["status"] == "confirmed"
    assert gateway.apply_calls == 1


async def test_http_prorated_delta_contract_is_explicit_and_server_calculated(
    postgres_container: None,
) -> None:
    gateway = FakeBillingGateway()
    database = Database(TEST_DSN)
    settings = _settings().model_copy(update={"billing_transition_policy": "prorated_delta"})
    app = create_app(
        settings,
        database=database,
        gateway=gateway,  # type: ignore[arg-type]
        auth_adapter=StaticAuth(),
    )
    headers = {"Authorization": "Bearer ignored", "Idempotency-Key": "delta-http-1"}
    async with app.router.lifespan_context(app):
        account = await database.account_for_external_ref("api-user")
        period_end = datetime(2030, 8, 1, tzinfo=UTC)
        async with database.require_pool().acquire() as conn:
            await conn.execute(
                """update billing_accounts set stripe_customer_id='cus_api',
                     stripe_subscription_id='sub_api',plan_key='starter',plan_interval='month',
                     subscription_status='active',credits_balance=300,grant_epoch=1,
                     current_period_end=$2,entitlement_period_end=$2,credit_expires_at=$2,
                     entitlement_revoked=false where id=$1""",
                account["id"],
                period_end,
            )
            await conn.execute(
                """insert into credit_ledger(
                       account_id,delta,balance_after,entitlement_units,reason,grant_epoch,
                       stripe_invoice_id,grant_slot)
                     values($1,300,300,300,'subscription_grant',1,'in_api_source',1)""",
                account["id"],
            )
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            catalog_response = await client.get(
                "/api/catalog", headers={"Authorization": "Bearer ignored"}
            )
            account_response = await client.get(
                "/api/account", headers={"Authorization": "Bearer ignored"}
            )
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
    assert catalog_response.json()["transition_policy"] == "prorated_delta"
    assert account_response.json()["transition_policy"] == "prorated_delta"
    assert body["transition_policy"] == "prorated_delta"
    assert body["settlement_mode"] == "current_period_prorated_delta"
    assert body["amount_due_now"] == 1500
    assert body["credit_applied"] == 950
    assert body["entitlement_credit_delta"] == 700
    assert confirm.status_code == 200, confirm.text
    assert confirm.json()["transition_policy"] == "prorated_delta"
    assert gateway.last_apply_kwargs is not None
    assert gateway.last_apply_kwargs["policy"] == "prorated_delta"
    assert isinstance(gateway.last_apply_kwargs["proration_date"], int)


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
        period_end = datetime(2030, 8, 1, tzinfo=UTC)
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
