from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
import pytest

from stripe_entitlements.app import create_app
from stripe_entitlements.auth import AuthenticatedIdentity, AuthenticationError
from stripe_entitlements.config import Settings
from stripe_entitlements.credits import CreditService
from stripe_entitlements.database import Database
from stripe_entitlements.plan_changes import (
    PlanChangeContext,
    PlanChangeEstimate,
    RemotePlanChange,
)
from stripe_entitlements.stripe_request_snapshots import (
    build_credit_pack_checkout_request_snapshot,
    build_subscription_checkout_request_snapshot,
)
from tests.conftest import TEST_DSN
from tests.credit_helpers import PRO_CREDITS, STARTER_CREDITS


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
        self.api_version = "2026-06-24.dahlia"
        self.product_line = "example-entitlements"
        self.checkout_success_url = "http://localhost:3000/billing/success"
        self.checkout_cancel_url = "http://localhost:3000/pricing"
        self.portal_return_url = "http://localhost:3000/account"
        self.portal_configuration_id = "bpc_test"
        self.checkout_kwargs = None
        self.pack_checkout_kwargs = None
        self.portal_keys: list[str] = []
        self.prepare_calls = 0
        self.preview_calls = 0
        self.apply_calls = 0
        self.last_apply_kwargs = None

    async def prepare_checkout_session(self, **kwargs):  # type: ignore[no-untyped-def]
        self.checkout_kwargs = kwargs
        return build_subscription_checkout_request_snapshot(
            account_id=kwargs["account_id"],
            claim_token=kwargs["claim_token"],
            customer_id=kwargs["customer_id"],
            price_id="price_api_subscription",
            lookup_key=kwargs["lookup_key"],
            currency=kwargs["expected_currency"],
            unit_amount=kwargs["expected_unit_amount"],
            interval=kwargs["expected_interval"],
            plan_key=kwargs["plan_key"],
            product_line="example-entitlements",
            success_url="https://app.example.test/success",
            cancel_url="https://app.example.test/pricing",
            expires_at=int(kwargs["expires_at"].timestamp()),
            request_api_version="2026-06-24.dahlia",
        )

    async def prepare_credit_pack_checkout_session(
        self,
        **kwargs,  # type: ignore[no-untyped-def]
    ) -> dict[str, object]:
        self.pack_checkout_kwargs = kwargs
        return build_credit_pack_checkout_request_snapshot(
            order_id=kwargs["order_id"],
            account_id=kwargs["account_id"],
            customer_id=kwargs["customer_id"],
            price_id="price_api_pack",
            lookup_key=kwargs["lookup_key"],
            currency=kwargs["expected_currency"],
            unit_amount=kwargs["expected_unit_amount"],
            pack_key=kwargs["pack_key"],
            pack_credits=kwargs["pack_credits"],
            expires_days=kwargs["expires_days"],
            product_line="example-entitlements",
            success_url="https://app.example.test/success",
            cancel_url="https://app.example.test/pricing",
            expires_at=int(kwargs["expires_at"].timestamp()),
            request_api_version="2026-06-24.dahlia",
        )

    async def create_checkout_session_from_snapshot(self, snapshot):  # type: ignore[no-untyped-def]
        if snapshot["kind"] == "credit_pack":
            return "cs_pack_api", "https://checkout.test/pack"
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
        self.prepare_calls += 1
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
        self.preview_calls += 1
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


@pytest.mark.parametrize(
    "checkout_success_url",
    [
        "http://localhost:3000/billing/success?campaign=launch",
        "http://localhost:3000/billing/success#done",
    ],
)
def test_checkout_success_url_base_rejects_query_and_fragment_at_startup(
    checkout_success_url: str,
) -> None:
    # model_copy deliberately bypasses Pydantic validation and proves the runtime
    # kernel independently enforces the same integration contract.
    settings = _settings().model_copy(update={"checkout_success_url": checkout_success_url})
    gateway = FakeBillingGateway()
    gateway.checkout_success_url = checkout_success_url
    with pytest.raises(ValueError, match="query or fragment"):
        create_app(
            settings,
            database=Database(TEST_DSN),
            gateway=gateway,  # type: ignore[arg-type]
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


def test_injected_gateway_api_version_must_match_settings() -> None:
    gateway = FakeBillingGateway()
    gateway.api_version = "2025-12-15.clover"
    with pytest.raises(ValueError, match="Stripe API versions do not match"):
        create_app(
            _settings(),
            database=Database(TEST_DSN),
            gateway=gateway,  # type: ignore[arg-type]
        )


def test_injected_gateway_product_line_must_match_before_database_connect() -> None:
    gateway = FakeBillingGateway()
    gateway.product_line = "different-product-line"
    database = Database(TEST_DSN)
    with pytest.raises(ValueError, match="product lines do not match"):
        create_app(
            _settings(),
            database=database,
            gateway=gateway,  # type: ignore[arg-type]
        )
    assert database.pool is None


@pytest.mark.parametrize(
    ("attribute", "value", "message"),
    [
        (
            "checkout_success_url",
            "https://different.example/billing/success",
            "Checkout success URLs do not match",
        ),
        (
            "checkout_cancel_url",
            "https://different.example/pricing",
            "Checkout cancel URLs do not match",
        ),
        (
            "portal_return_url",
            "https://different.example/account",
            "Portal return URLs do not match",
        ),
        (
            "portal_configuration_id",
            "bpc_different",
            "Portal configuration IDs do not match",
        ),
    ],
)
def test_injected_gateway_urls_and_portal_configuration_must_match_before_connect(
    attribute: str,
    value: str,
    message: str,
) -> None:
    gateway = FakeBillingGateway()
    setattr(gateway, attribute, value)
    database = Database(TEST_DSN)
    with pytest.raises(ValueError, match=message):
        create_app(
            _settings(),
            database=database,
            gateway=gateway,  # type: ignore[arg-type]
        )
    assert database.pool is None


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
        ("00000000-0000-4000-8000-000000000001", None),
        ("cus_authenticated_owner", None),
        ("sub_authenticated_owner", None),
        ("acct_authenticated_owner", None),
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


@pytest.mark.parametrize("invalid_subscription_state", ["expired", "revoked", "past_due"])
async def test_account_and_charge_report_only_currently_spendable_funding(
    invalid_subscription_state: str,
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
        kernel = app.state.stripe_entitlements
        pack = kernel.catalog.require_credit_pack("boost-100")
        reservation = await kernel.require_services().credit_packs.reserve(
            str(account["id"]),
            pack,
            f"account-spendability-{invalid_subscription_state}",
        )
        async with database.require_pool().acquire() as conn, conn.transaction():
            database_now = await conn.fetchval("select clock_timestamp()")
            credit_expires_at = database_now + timedelta(hours=1)
            if invalid_subscription_state == "expired":
                credit_expires_at = database_now - timedelta(seconds=1)
            await conn.execute(
                """update billing_accounts
                      set plan_key='starter',plan_interval='month',
                          subscription_status=$2,entitlement_revoked=$3,
                          credits_balance=300000000,credit_expires_at=$4
                    where id=$1""",
                account["id"],
                "past_due" if invalid_subscription_state == "past_due" else "active",
                invalid_subscription_state == "revoked",
                credit_expires_at,
            )
            await conn.execute(
                """update credit_pack_orders
                      set checkout_status='completed',payment_status='paid',
                          stripe_checkout_session_id=$2,stripe_payment_intent_id=$3,
                          stripe_charge_id=$4,amount_paid=price_amount,paid_at=$5
                    where id=$1::uuid""",
                reservation.order_id,
                f"cs_{reservation.order_id}",
                f"pi_{reservation.order_id}",
                f"ch_{reservation.order_id}",
                database_now,
            )
            await conn.execute(
                """insert into credit_funding_lots(
                       id,order_id,account_id,original_credits,remaining_credits,expires_at)
                     values($1,$2::uuid,$3,$4,$4,$5)""",
                uuid.uuid4(),
                reservation.order_id,
                account["id"],
                100_000_000,
                database_now + timedelta(days=30),
            )

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            before = await client.get("/api/account", headers={"Authorization": "Bearer ignored"})
            charged = await CreditService(database.require_pool()).charge(
                str(account["id"]), "25", f"pack-job-{invalid_subscription_state}"
            )
            after = await client.get("/api/account", headers={"Authorization": "Bearer ignored"})

    assert before.status_code == 200
    assert before.json()["entitlements_enforceable"] is False
    assert before.json()["credits"]["subscription_balance"] == "0"
    assert before.json()["credits"]["subscription_balance_atoms"] == "0"
    assert before.json()["credits"]["purchased_balance"] == "100"
    assert before.json()["credits"]["purchased_balance_atoms"] == "100000000"
    assert before.json()["credits"]["balance"] == "100"
    assert before.json()["credits"]["balance_atoms"] == "100000000"
    assert len(before.json()["credits"]["credit_packs"]) == 1
    assert (charged.outcome, charged.balance.atoms) == ("charged", 75_000_000)
    assert after.json()["credits"]["subscription_balance"] == "0"
    assert after.json()["credits"]["purchased_balance"] == "75"
    assert after.json()["credits"]["balance"] == "75"


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
    gateway.checkout_success_url = settings.checkout_success_url
    gateway.checkout_cancel_url = settings.checkout_cancel_url
    gateway.portal_return_url = settings.portal_return_url
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


async def test_stripe_mode_requirement_is_uniform_and_precedes_billing_io(
    monkeypatch: pytest.MonkeyPatch,
    postgres_container: None,
) -> None:
    requests = [
        (
            "checkout",
            "/api/checkout",
            {"Idempotency-Key": "mode-checkout"},
            {
                "plan_key": "starter",
                "interval": "month",
                "success_url": "http://localhost:3000/billing/success",
                "cancel_url": "http://localhost:3000/pricing",
            },
        ),
        (
            "credit_pack",
            "/api/credit-packs/checkout",
            {"Idempotency-Key": "mode-pack"},
            {
                "pack_key": "boost-100",
                "success_url": "http://localhost:3000/billing/success",
                "cancel_url": "http://localhost:3000/pricing",
            },
        ),
        (
            "portal",
            "/api/billing/portal",
            {"Idempotency-Key": "mode-portal"},
            {"return_url": "http://localhost:3000/account"},
        ),
        (
            "preview",
            "/api/billing/change/preview",
            {"Idempotency-Key": "mode-preview"},
            {"plan_key": "pro", "interval": "month"},
        ),
        (
            "confirm",
            "/api/billing/change/confirm",
            {},
            {"preview_id": "00000000-0000-4000-8000-000000000001"},
        ),
    ]

    async def reject_business_account_lookup(external_ref: str) -> None:
        raise AssertionError(f"unexpected billing account lookup for {external_ref}")

    def assert_gateway_idle(gateway: FakeBillingGateway) -> None:
        assert gateway.checkout_kwargs is None
        assert gateway.pack_checkout_kwargs is None
        assert gateway.portal_keys == []
        assert gateway.prepare_calls == 0
        assert gateway.preview_calls == 0
        assert gateway.apply_calls == 0

    test_gateway = FakeBillingGateway()
    test_database = Database(TEST_DSN)
    monkeypatch.setattr(
        test_database,
        "existing_account_for_external_ref",
        reject_business_account_lookup,
    )
    test_app = create_app(
        _settings(),
        database=test_database,
        gateway=test_gateway,  # type: ignore[arg-type]
        auth_adapter=StaticAuth(),
    )
    invalid_responses: dict[str, httpx.Response] = {}
    async with test_app.router.lifespan_context(test_app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=test_app), base_url="http://test"
        ) as client:
            for name, path, headers, body in requests:
                invalid_responses[name] = await client.post(
                    path,
                    headers={
                        "Authorization": "Bearer ignored",
                        "X-Stripe-Mode-Requirement": "live",
                        **headers,
                    },
                    json=body,
                )

    assert set(invalid_responses) == {name for name, *_ in requests}
    for response in invalid_responses.values():
        assert response.status_code == 400
        assert response.json() == {"detail": "X-Stripe-Mode-Requirement must be test when supplied"}
    assert_gateway_idle(test_gateway)

    live_settings = _settings().model_copy(
        update={
            "stripe_secret_key": "sk_live_dummy",
            "checkout_success_url": "https://app.example/billing/success",
            "checkout_cancel_url": "https://app.example/pricing",
            "portal_return_url": "https://app.example/account",
            "frontend_origins": "https://app.example",
        }
    )
    live_gateway = FakeBillingGateway()
    live_gateway.secret_key = "sk_live_fake_billing_gateway"
    live_gateway.checkout_success_url = live_settings.checkout_success_url
    live_gateway.checkout_cancel_url = live_settings.checkout_cancel_url
    live_gateway.portal_return_url = live_settings.portal_return_url
    live_database = Database(TEST_DSN)
    monkeypatch.setattr(
        live_database,
        "existing_account_for_external_ref",
        reject_business_account_lookup,
    )
    live_app = create_app(
        live_settings,
        database=live_database,
        gateway=live_gateway,  # type: ignore[arg-type]
        auth_adapter=StaticAuth(),
    )
    live_responses: dict[str, httpx.Response] = {}
    async with live_app.router.lifespan_context(live_app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=live_app), base_url="http://test"
        ) as client:
            for name, path, headers, body in requests:
                live_responses[name] = await client.post(
                    path,
                    headers={
                        "Authorization": "Bearer ignored",
                        "X-Stripe-Mode-Requirement": "test",
                        **headers,
                    },
                    json=body,
                )

    assert set(live_responses) == {name for name, *_ in requests}
    for response in live_responses.values():
        assert response.status_code == 409
        assert response.json() == {
            "detail": "billing backend is not in the required Stripe test mode"
        }
    assert_gateway_idle(live_gateway)


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
        async def create_checkout_session_from_snapshot(self, snapshot):  # type: ignore[no-untyped-def]
            del snapshot
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


async def test_subscription_frozen_recovery_survives_catalog_and_url_drift(
    postgres_container: None,
) -> None:
    class UnknownOnceGateway(FakeBillingGateway):
        def __init__(self) -> None:
            super().__init__()
            self.create_calls = 0

        async def create_checkout_session_from_snapshot(self, snapshot):  # type: ignore[no-untyped-def]
            self.create_calls += 1
            if self.create_calls == 1:
                raise TimeoutError("unknown Stripe outcome")
            return await super().create_checkout_session_from_snapshot(snapshot)

    gateway = UnknownOnceGateway()
    database = Database(TEST_DSN)
    auth = IdentityAuth("subscription-recovery-owner", "owner@example.test")
    app = create_app(
        _settings(),
        database=database,
        gateway=gateway,  # type: ignore[arg-type]
        auth_adapter=auth,
    )
    headers = {"Authorization": "Bearer ignored", "Idempotency-Key": "frozen-sub"}
    valid = {
        "plan_key": "starter",
        "interval": "month",
        "success_url": "http://localhost:3000/billing/success",
        "cancel_url": "http://localhost:3000/pricing",
    }
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            first = await client.post("/api/checkout", headers=headers, json=valid)
            app.state.stripe_entitlements.catalog.plans.pop("starter")
            recovered = await client.post(
                "/api/checkout",
                headers=headers,
                json={
                    **valid,
                    "success_url": "https://configuration-drift.invalid/success",
                    "cancel_url": "https://configuration-drift.invalid/cancel",
                },
            )
            wrong_target = await client.post(
                "/api/checkout",
                headers=headers,
                json={**valid, "plan_key": "pro"},
            )
            new_key = await client.post(
                "/api/checkout",
                headers={**headers, "Idempotency-Key": "new-missing-plan"},
                json=valid,
            )
            auth.identity = AuthenticatedIdentity("subscription-recovery-other")
            wrong_owner = await client.post("/api/checkout", headers=headers, json=valid)
        async with database.require_pool().acquire() as conn:
            claims = await conn.fetch(
                """select request_snapshot_version,session_id
                     from checkout_claims order by client_request_key"""
            )

    assert first.status_code == 502
    assert recovered.status_code == 200
    assert recovered.json() == {"url": "https://checkout.test/api"}
    assert wrong_target.status_code == 409
    assert new_key.status_code == 400
    assert wrong_owner.status_code == 400
    assert gateway.create_calls == 2
    assert len(claims) == 1
    assert tuple(claims[0]) == (1, "cs_api")


async def test_credit_pack_frozen_recovery_survives_catalog_and_url_drift(
    postgres_container: None,
) -> None:
    class UnknownOnceGateway(FakeBillingGateway):
        def __init__(self) -> None:
            super().__init__()
            self.create_calls = 0

        async def create_checkout_session_from_snapshot(self, snapshot):  # type: ignore[no-untyped-def]
            self.create_calls += 1
            if self.create_calls == 1:
                raise TimeoutError("unknown Stripe outcome")
            return await super().create_checkout_session_from_snapshot(snapshot)

    gateway = UnknownOnceGateway()
    database = Database(TEST_DSN)
    auth = IdentityAuth("pack-recovery-owner", "owner@example.test")
    app = create_app(
        _settings(),
        database=database,
        gateway=gateway,  # type: ignore[arg-type]
        auth_adapter=auth,
    )
    headers = {"Authorization": "Bearer ignored", "Idempotency-Key": "frozen-pack"}
    valid = {
        "pack_key": "boost-100",
        "success_url": "http://localhost:3000/billing/success",
        "cancel_url": "http://localhost:3000/pricing",
    }
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            first = await client.post("/api/credit-packs/checkout", headers=headers, json=valid)
            app.state.stripe_entitlements.catalog.credit_packs.pop("boost-100")
            recovered = await client.post(
                "/api/credit-packs/checkout",
                headers=headers,
                json={
                    **valid,
                    "success_url": "https://configuration-drift.invalid/success",
                    "cancel_url": "https://configuration-drift.invalid/cancel",
                },
            )
            wrong_target = await client.post(
                "/api/credit-packs/checkout",
                headers=headers,
                json={**valid, "pack_key": "boost-500"},
            )
            new_key = await client.post(
                "/api/credit-packs/checkout",
                headers={**headers, "Idempotency-Key": "new-missing-pack"},
                json=valid,
            )
            auth.identity = AuthenticatedIdentity("pack-recovery-other")
            wrong_owner = await client.post(
                "/api/credit-packs/checkout", headers=headers, json=valid
            )
        async with database.require_pool().acquire() as conn:
            orders = await conn.fetch(
                """select request_snapshot_version,stripe_checkout_session_id
                     from credit_pack_orders order by client_idempotency_key"""
            )

    assert first.status_code == 502
    assert recovered.status_code == 200
    assert recovered.json() == {
        "session_id": "cs_pack_api",
        "url": "https://checkout.test/pack",
    }
    assert wrong_target.status_code == 409
    assert new_key.status_code == 400
    assert wrong_owner.status_code == 400
    assert gateway.create_calls == 2
    assert len(orders) == 1
    assert tuple(orders[0]) == (1, "cs_pack_api")


async def test_legacy_checkout_snapshots_map_to_conflict_without_gateway_io(
    postgres_container: None,
) -> None:
    gateway = FakeBillingGateway()
    database = Database(TEST_DSN)
    auth = IdentityAuth("legacy-checkout-owner")
    app = create_app(
        _settings(),
        database=database,
        gateway=gateway,  # type: ignore[arg-type]
        auth_adapter=auth,
    )
    async with app.router.lifespan_context(app):
        kernel = app.state.stripe_entitlements
        account = await database.account_for_external_ref("legacy-checkout-owner")
        checkout = await kernel.require_services().checkout.reserve(
            str(account["id"]), "starter", "month", request_key="legacy-sub"
        )
        async with database.require_pool().acquire() as conn:
            await conn.execute(
                """update checkout_claims set request_snapshot_version=null
                     where account_id=$1::uuid""",
                account["id"],
            )
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            subscription = await client.post(
                "/api/checkout",
                headers={
                    "Authorization": "Bearer ignored",
                    "Idempotency-Key": "legacy-sub",
                },
                json={
                    "plan_key": "starter",
                    "interval": "month",
                    "success_url": "http://localhost:3000/billing/success",
                    "cancel_url": "http://localhost:3000/pricing",
                },
            )

            auth.identity = AuthenticatedIdentity("legacy-pack-owner")
            pack_account = await database.account_for_external_ref("legacy-pack-owner")
            pack = kernel.catalog.require_credit_pack("boost-100")
            order = await kernel.require_services().credit_packs.reserve(
                str(pack_account["id"]), pack, "legacy-pack"
            )
            async with database.require_pool().acquire() as conn:
                await conn.execute(
                    """update credit_pack_orders set request_snapshot_version=null
                         where id=$1::uuid""",
                    order.order_id,
                )
            credit_pack = await client.post(
                "/api/credit-packs/checkout",
                headers={
                    "Authorization": "Bearer ignored",
                    "Idempotency-Key": "legacy-pack",
                },
                json={
                    "pack_key": "boost-100",
                    "success_url": "http://localhost:3000/billing/success",
                    "cancel_url": "http://localhost:3000/pricing",
                },
            )

    assert checkout.request_snapshot_version == 0
    assert subscription.status_code == 409
    assert "predates durable request snapshots" in subscription.json()["detail"]
    assert credit_pack.status_code == 409
    assert "predates durable request snapshots" in credit_pack.json()["detail"]
    assert gateway.checkout_kwargs is None
    assert gateway.pack_checkout_kwargs is None


async def test_malformed_frozen_checkout_snapshots_require_operator_reconciliation(
    postgres_container: None,
) -> None:
    gateway = FakeBillingGateway()
    database = Database(TEST_DSN)
    auth = IdentityAuth("malformed-checkout-owner")
    app = create_app(
        _settings(),
        database=database,
        gateway=gateway,  # type: ignore[arg-type]
        auth_adapter=auth,
    )
    async with app.router.lifespan_context(app):
        kernel = app.state.stripe_entitlements
        account = await database.account_for_external_ref("malformed-checkout-owner")
        await kernel.require_services().checkout.reserve(
            str(account["id"]), "starter", "month", request_key="malformed-sub"
        )
        async with database.require_pool().acquire() as conn:
            await conn.execute(
                """update checkout_claims
                      set request_snapshot_version=1,stripe_request_snapshot='{}'::jsonb
                    where account_id=$1::uuid""",
                account["id"],
            )

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            subscription = await client.post(
                "/api/checkout",
                headers={
                    "Authorization": "Bearer ignored",
                    "Idempotency-Key": "malformed-sub",
                },
                json={
                    "plan_key": "starter",
                    "interval": "month",
                    "success_url": "http://localhost:3000/billing/success",
                    "cancel_url": "http://localhost:3000/pricing",
                },
            )

            auth.identity = AuthenticatedIdentity("malformed-pack-owner")
            pack_account = await database.account_for_external_ref("malformed-pack-owner")
            order = await kernel.require_services().credit_packs.reserve(
                str(pack_account["id"]),
                kernel.catalog.require_credit_pack("boost-100"),
                "malformed-pack",
            )
            async with database.require_pool().acquire() as conn:
                await conn.execute(
                    """update credit_pack_orders
                          set request_snapshot_version=1,
                              stripe_request_snapshot='{}'::jsonb
                        where id=$1::uuid""",
                    order.order_id,
                )
            credit_pack = await client.post(
                "/api/credit-packs/checkout",
                headers={
                    "Authorization": "Bearer ignored",
                    "Idempotency-Key": "malformed-pack",
                },
                json={
                    "pack_key": "boost-100",
                    "success_url": "http://localhost:3000/billing/success",
                    "cancel_url": "http://localhost:3000/pricing",
                },
            )

    assert subscription.status_code == 409
    assert "operator reconciliation is required" in subscription.json()["detail"]
    assert credit_pack.status_code == 409
    assert "operator reconciliation is required" in credit_pack.json()["detail"]
    assert gateway.checkout_kwargs is None
    assert gateway.pack_checkout_kwargs is None


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
                       credits_balance=300000000,credit_expires_at=now()+interval '1 hour'
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
    assert response.json()["credits"]["subscription_balance"] == "0"
    assert response.json()["credits"]["balance"] == "0"


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
            # The fake gateway does not emit Checkout/customer webhooks. Project the
            # one fact this combined contract test needs before starting a second
            # purchase type; cross-type first-customer single-flight has its own
            # concurrency tests and must not be bypassed in production code.
            local = await database.account_for_external_ref("api-user")
            async with database.require_pool().acquire() as conn:
                await conn.execute(
                    "update billing_accounts set stripe_customer_id='cus_api' where id=$1",
                    local["id"],
                )
                await conn.execute("delete from checkout_claims where account_id=$1", local["id"])
            pack_checkout = await client.post(
                "/api/credit-packs/checkout",
                headers={**headers, "Idempotency-Key": "pack-request-1"},
                json={
                    "pack_key": "boost-100",
                    "success_url": (
                        "http://localhost:3000/billing/success?expected_credit_pack=boost-100"
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
    assert catalog.json()["credit_packs"][0] == {
        "key": "boost-100",
        "name": "Boost 100",
        "description": "A small one-time balance for occasional extra jobs.",
        "display_order": 10,
        "credits": "100",
        "credits_atoms": "100000000",
        "credit_scale": 1_000_000,
        "price": {"currency": "usd", "unit_amount": 1500},
        "expires_days": 365,
    }
    first = catalog.json()["plans"][0]
    assert set(first) >= {"name", "description", "display_order", "prices", "entitlements"}
    assert first["prices"]["month"]["unit_amount"] == 1900
    entitlements = {item["key"]: item for item in first["entitlements"]}
    assert entitlements["monthly_credits"] == {
        "key": "monthly_credits",
        "label": "Credits per monthly grant",
        "value": "300",
        "value_atoms": str(STARTER_CREDITS),
        "scale": 1_000_000,
        "unit": "credits",
    }
    assert entitlements["pdf_to_ppt"]["label"] == "PDF to PowerPoint"
    assert entitlements["max_file_mb"]["unit"] == "MB"
    assert entitlements["max_pages_per_job"]["unit"] == "pages"
    assert account.json()["plan_key"] == "free"
    assert account.json()["credits"] == {
        "balance": "0",
        "balance_atoms": "0",
        "subscription_balance": "0",
        "subscription_balance_atoms": "0",
        "purchased_balance": "0",
        "purchased_balance_atoms": "0",
        "grant_amount": "0",
        "grant_amount_atoms": "0",
        "scale": 1_000_000,
        "next_grant_at": None,
        "credit_packs": [],
    }
    for response in (catalog, account, checkout, pack_checkout, invalid_redirect, portal):
        assert response.headers["cache-control"] == "no-store"
        assert response.headers["pragma"] == "no-cache"
        assert response.headers["x-content-type-options"] == "nosniff"
    assert checkout.json() == {"url": "https://checkout.test/api"}
    assert pack_checkout.json() == {
        "session_id": "cs_pack_api",
        "url": "https://checkout.test/pack",
    }
    assert gateway.pack_checkout_kwargs["pack_key"] == "boost-100"
    assert gateway.pack_checkout_kwargs["expected_unit_amount"] == 1500
    assert gateway.checkout_kwargs["plan_key"] == "starter"
    assert invalid_redirect.status_code == 400
    assert portal.json() == {
        "session_id": "bps_api",
        "url": "https://billing.stripe.test/session",
    }
    assert gateway.portal_keys == [f"portal:{local['id']}:portal-1"]


async def test_portal_scoped_idempotency_key_needs_no_hash(
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
    client_key = "x" * 200
    async with app.router.lifespan_context(app):
        account = await database.account_for_external_ref("api-user")
        async with database.require_pool().acquire() as conn:
            await conn.execute(
                "update billing_accounts set stripe_customer_id='cus_api' where id=$1",
                account["id"],
            )
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.post(
                "/api/billing/portal",
                headers={
                    "Authorization": "Bearer ignored",
                    "Idempotency-Key": client_key,
                },
                json={"return_url": "http://localhost:3000/account"},
            )
    assert response.status_code == 200
    assert len(gateway.portal_keys) == 1
    scoped_key = gateway.portal_keys[0]
    assert scoped_key == f"portal:{account['id']}:{client_key}"
    assert len(scoped_key.encode("utf-8")) <= 255


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


async def test_malformed_plan_change_snapshot_requires_operator_reconciliation_without_io(
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
        "Idempotency-Key": "malformed-plan-snapshot",
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
            calls_after_preview = (
                gateway.prepare_calls,
                gateway.preview_calls,
                gateway.apply_calls,
            )
            async with database.require_pool().acquire() as conn:
                await conn.execute(
                    """update billing_plan_changes
                          set request_snapshot_version=1,
                              stripe_request_snapshot='{}'::jsonb
                        where id=$1::uuid""",
                    preview_id,
                )
            confirm = await client.post(
                "/api/billing/change/confirm",
                headers={"Authorization": "Bearer ignored"},
                json={"preview_id": preview_id},
            )

    assert preview.status_code == 200, preview.text
    assert confirm.status_code == 409
    assert "operator reconciliation is required" in confirm.json()["detail"]
    assert calls_after_preview == (1, 1, 0)
    assert (
        gateway.prepare_calls,
        gateway.preview_calls,
        gateway.apply_calls,
    ) == calls_after_preview


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
                     subscription_status='active',credits_balance=$3,grant_epoch=1,
                     current_period_end=$2,entitlement_period_end=$2,credit_expires_at=$2,
                     entitlement_revoked=false where id=$1""",
                account["id"],
                period_end,
                STARTER_CREDITS,
            )
            await conn.execute(
                """insert into credit_ledger(
                       account_id,delta,balance_after,entitlement_units,reason,grant_epoch,
                       stripe_invoice_id,grant_slot)
                     values($1,$2,$2,$2,'subscription_grant',1,'in_api_source',1)""",
                account["id"],
                STARTER_CREDITS,
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
    assert body["entitlement_credit_delta"] == "700"
    assert body["entitlement_credit_delta_atoms"] == str(PRO_CREDITS - STARTER_CREDITS)
    assert body["credit_scale"] == 1_000_000
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
