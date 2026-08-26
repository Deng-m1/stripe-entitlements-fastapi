from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

import asyncpg
import pytest

from stripe_entitlements.checkout import (
    CheckoutBusyError,
    CheckoutCoordinator,
    CheckoutCreationRejected,
)
from stripe_entitlements.processor import EventProcessor
from tests.builders import checkout_event


async def test_checkout_reservation_uses_database_clock(pool: asyncpg.Pool, make_account) -> None:
    account_id = await make_account(customer=None, subscription=None)
    coordinator = CheckoutCoordinator(pool)
    async with pool.acquire() as conn:
        before = await conn.fetchval("select now()")
    reservation = await coordinator.reserve(account_id, "starter", "month")
    async with pool.acquire() as conn:
        after = await conn.fetchval("select now()")
    assert before + timedelta(minutes=35) <= reservation.expires_at
    assert reservation.expires_at <= after + timedelta(minutes=35)


@pytest.mark.parametrize(
    ("now", "ttl", "message"),
    [
        (None, timedelta(0), "positive"),
        (datetime(2026, 1, 1), timedelta(minutes=35), "timezone-aware"),
    ],
)
async def test_checkout_reservation_rejects_invalid_time_inputs(
    now: datetime | None,
    ttl: timedelta,
    message: str,
    pool: asyncpg.Pool,
    make_account,
) -> None:
    account_id = await make_account(customer=None, subscription=None)
    with pytest.raises(ValueError, match=message):
        await CheckoutCoordinator(pool).reserve(
            account_id,
            "starter",
            "month",
            now=now,
            ttl=ttl,
        )


@pytest.mark.parametrize(
    ("plan_key", "interval", "request_key"),
    [
        ("", "month", None),
        (" padded ", "month", None),
        ("bad_plan", "month", None),
        ("starter", "week", None),
        ("starter", "month", ""),
        ("starter", "month", " padded "),
        ("starter", "month", "delete\x7f"),
        ("starter", "month", "zero\u200bwidth"),
        ("starter", "month", "x" * 201),
    ],
)
async def test_checkout_reservation_validates_direct_library_inputs(
    plan_key: str,
    interval: str,
    request_key: str | None,
    pool: asyncpg.Pool,
    make_account,
) -> None:
    account_id = await make_account(customer=None, subscription=None)
    with pytest.raises(ValueError):
        await CheckoutCoordinator(pool).reserve(
            account_id,
            plan_key,
            interval,
            request_key=request_key,
        )
    async with pool.acquire() as conn:
        assert await conn.fetchval("select count(*) from checkout_claims") == 0


async def test_invalid_checkout_session_identity_is_not_attached(
    pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account(customer=None, subscription=None)
    coordinator = CheckoutCoordinator(pool)
    reservation = await coordinator.reserve(account_id, "starter", "month")
    with pytest.raises(ValueError, match="HTTPS"):
        await coordinator.attach_session(
            reservation,
            "cs_invalid_url",
            "http://checkout.invalid/session",
        )
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "select session_id,session_url from checkout_claims where account_id=$1",
            account_id,
        )
    assert row is not None and tuple(row) == (None, None)


async def test_checkout_session_fragment_is_preserved_and_attached(
    pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account(customer=None, subscription=None)
    coordinator = CheckoutCoordinator(pool)
    reservation = await coordinator.reserve(account_id, "starter", "month")
    session_url = "https://checkout.stripe.com/c/pay/test#stripe-hosted-state"

    assert await coordinator.attach_session(reservation, "cs_fragment", session_url)
    async with pool.acquire() as conn:
        stored = await conn.fetchrow(
            "select session_id,session_url from checkout_claims where account_id=$1",
            account_id,
        )
    assert stored is not None and tuple(stored) == ("cs_fragment", session_url)


async def test_invalid_creator_session_identity_retains_claim_for_safe_retry(
    pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account(customer=None, subscription=None)
    coordinator = CheckoutCoordinator(pool)

    class InvalidCreator:
        async def create_checkout_session(self, **kwargs):  # type: ignore[no-untyped-def]
            del kwargs
            return "cs_invalid", "http://checkout.invalid/session"

    with pytest.raises(RuntimeError, match="invalid Session identity"):
        await coordinator.create(
            InvalidCreator(),
            account_id=account_id,
            customer_id=None,
            plan_key="starter",
            interval="month",
            lookup_key="ent_starter_month",
            expected_currency="usd",
            expected_unit_amount=1900,
            expected_interval="month",
            request_key="invalid-creator-result",
        )
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "select client_request_key,session_id from checkout_claims where account_id=$1",
            account_id,
        )
    assert row is not None and tuple(row) == ("invalid-creator-result", None)


async def test_concurrent_checkout_reservations_allow_exactly_one(
    pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account(customer=None, subscription=None)
    coordinator = CheckoutCoordinator(pool)

    async def reserve() -> str:
        try:
            value = await coordinator.reserve(account_id, "starter", "month")
            return value.claim_token
        except CheckoutBusyError:
            return "busy"

    results = await asyncio.gather(*(reserve() for _ in range(20)))
    assert sum(result != "busy" for result in results) == 1


async def test_only_claim_owner_can_attach_or_release(pool: asyncpg.Pool, make_account) -> None:
    account_id = await make_account(customer=None, subscription=None)
    coordinator = CheckoutCoordinator(pool)
    reservation = await coordinator.reserve(account_id, "starter", "month")
    impostor = reservation.__class__(
        reservation.account_id,
        "00000000-0000-0000-0000-000000000000",
        reservation.plan_key,
        reservation.interval,
        reservation.expires_at,
        "impostor-request",
    )
    assert not await coordinator.attach_session(impostor, "cs_impostor", "https://invalid")
    assert not await coordinator.release(impostor)
    assert await coordinator.attach_session(reservation, "cs_owner", "https://checkout/owner")


async def test_expired_claim_can_be_replaced_and_old_expiration_cannot_delete_new(
    pool: asyncpg.Pool, processor: EventProcessor, make_account
) -> None:
    account_id = await make_account(customer=None, subscription=None)
    coordinator = CheckoutCoordinator(pool)
    old = await coordinator.reserve(
        account_id,
        "starter",
        "month",
        now=datetime(2026, 1, 1, tzinfo=UTC),
        ttl=timedelta(minutes=1),
    )
    assert await coordinator.attach_session(old, "cs_old", "https://checkout/old")
    new = await coordinator.reserve(
        account_id,
        "pro",
        "year",
        now=datetime(2026, 1, 1, 0, 2, tzinfo=UTC),
    )
    assert await coordinator.attach_session(new, "cs_new", "https://checkout/new")
    result = await processor.process(
        checkout_event("checkout.session.expired", account_id, "cs_old")
    )
    assert result.outcome == "ignored"
    async with pool.acquire() as conn:
        active = await conn.fetchval(
            "select session_id from checkout_claims where account_id=$1::uuid", account_id
        )
    assert active == "cs_new"


async def test_stale_checkout_completion_does_not_bind_subscription(
    pool: asyncpg.Pool, processor: EventProcessor, make_account
) -> None:
    account_id = await make_account(customer=None, subscription=None)
    coordinator = CheckoutCoordinator(pool)
    claim = await coordinator.reserve(account_id, "starter", "month")
    assert await coordinator.attach_session(claim, "cs_current", "https://checkout/current")
    result = await processor.process(
        checkout_event(
            "checkout.session.completed",
            account_id,
            "cs_stale",
            subscription="sub_stale",
        )
    )
    assert result.outcome == "ignored"
    async with pool.acquire() as conn:
        account = await conn.fetchrow(
            "select stripe_subscription_id from billing_accounts where id=$1::uuid", account_id
        )
        incident = await conn.fetchval(
            "select count(*) from billing_incidents where kind='stale_checkout_completion'"
        )
    assert account is not None and account["stripe_subscription_id"] is None
    assert incident == 1


@pytest.mark.parametrize("observed", [None, "other-product"])
async def test_checkout_completion_uses_exact_claim_not_advisory_product_line(
    observed: str | None,
    pool: asyncpg.Pool,
    processor: EventProcessor,
    make_account,
) -> None:
    account_id = await make_account(customer=None, subscription=None)
    coordinator = CheckoutCoordinator(pool)
    claim = await coordinator.reserve(
        account_id, "starter", "month", request_key=f"advisory-product-line-{observed}"
    )
    session_id = f"cs_advisory_product_line_{observed}"
    assert await coordinator.attach_session(
        claim, session_id, f"https://checkout.test/{session_id}"
    )
    payload = checkout_event(
        "checkout.session.completed",
        account_id,
        session_id,
        subscription=f"sub_advisory_product_line_{observed}",
        claim_token=claim.claim_token,
    )
    metadata = payload["data"]["object"]["metadata"]
    if observed is None:
        metadata.pop("product_line")
    else:
        metadata["product_line"] = observed

    result = await processor.process(payload)
    async with pool.acquire() as conn:
        account = await conn.fetchrow(
            "select stripe_customer_id,stripe_subscription_id from billing_accounts where id=$1",
            account_id,
        )
        active_claim = await conn.fetchval(
            "select session_id from checkout_claims where account_id=$1",
            account_id,
        )
    assert result.outcome == "handled"
    assert account is not None and tuple(account) == (
        "cus_checkout",
        f"sub_advisory_product_line_{observed}",
    )
    assert active_claim is None


async def test_checkout_completion_requires_customer_identity(
    pool: asyncpg.Pool, processor: EventProcessor, make_account
) -> None:
    account_id = await make_account(customer=None, subscription=None)
    coordinator = CheckoutCoordinator(pool)
    claim = await coordinator.reserve(
        account_id, "starter", "month", request_key="missing-customer"
    )
    assert await coordinator.attach_session(
        claim, "cs_missing_customer", "https://checkout/missing-customer"
    )
    payload = checkout_event(
        "checkout.session.completed",
        account_id,
        "cs_missing_customer",
        subscription="sub_missing_customer",
        claim_token=claim.claim_token,
    )
    payload["data"]["object"]["customer"] = None

    result = await processor.process(payload)
    async with pool.acquire() as conn:
        account = await conn.fetchrow(
            "select stripe_customer_id,stripe_subscription_id from billing_accounts where id=$1",
            account_id,
        )
        active_claim = await conn.fetchval(
            "select session_id from checkout_claims where account_id=$1",
            account_id,
        )
        incident = await conn.fetchval(
            """select count(*) from billing_incidents
                 where kind='checkout_customer_identity_conflict'"""
        )
    assert result.outcome == "ignored"
    assert account is not None and tuple(account) == (None, None)
    assert active_claim == "cs_missing_customer"
    assert incident == 1


async def test_deterministic_checkout_rejection_releases_own_claim(
    pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account(customer=None, subscription=None)
    coordinator = CheckoutCoordinator(pool)

    class FailingCreator:
        async def create_checkout_session(self, **kwargs):  # type: ignore[no-untyped-def]
            raise CheckoutCreationRejected("request was rejected before creation")

    with pytest.raises(CheckoutCreationRejected):
        await coordinator.create(
            FailingCreator(),
            account_id=account_id,
            customer_id=None,
            plan_key="starter",
            interval="month",
            lookup_key="ent_starter_month",
            expected_currency="usd",
            expected_unit_amount=1900,
            expected_interval="month",
        )
    async with pool.acquire() as conn:
        assert await conn.fetchval("select count(*) from checkout_claims") == 0


async def test_unknown_checkout_failure_retains_claim_for_same_key_retry(
    pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account(customer=None, subscription=None)
    coordinator = CheckoutCoordinator(pool)

    class FlakyCreator:
        calls = 0

        async def create_checkout_session(self, **kwargs):  # type: ignore[no-untyped-def]
            self.calls += 1
            if self.calls == 1:
                raise TimeoutError("outcome unknown")
            return "cs_recovered", "https://checkout/recovered"

    creator = FlakyCreator()
    with pytest.raises(TimeoutError):
        await coordinator.create(
            creator,
            account_id=account_id,
            customer_id=None,
            plan_key="starter",
            interval="month",
            lookup_key="ent_starter_month",
            expected_currency="usd",
            expected_unit_amount=1900,
            expected_interval="month",
            request_key="same-request",
        )
    session = await coordinator.create(
        creator,
        account_id=account_id,
        customer_id=None,
        plan_key="starter",
        interval="month",
        lookup_key="ent_starter_month",
        expected_currency="usd",
        expected_unit_amount=1900,
        expected_interval="month",
        request_key="same-request",
    )
    assert session == ("cs_recovered", "https://checkout/recovered")
    async with pool.acquire() as conn:
        row = await conn.fetchrow("select * from checkout_claims")
    assert row is not None and row["client_request_key"] == "same-request"


async def test_checkout_completed_before_api_attach_converges_by_claim_token(
    pool: asyncpg.Pool, processor: EventProcessor, make_account
) -> None:
    account_id = await make_account(customer=None, subscription=None)
    coordinator = CheckoutCoordinator(pool)

    class WebhookBeforeReturnCreator:
        async def create_checkout_session(self, **kwargs):  # type: ignore[no-untyped-def]
            result = await processor.process(
                checkout_event(
                    "checkout.session.completed",
                    account_id,
                    "cs_early",
                    subscription="sub_early",
                    claim_token=kwargs["claim_token"],
                )
            )
            assert result.outcome == "handled"
            return "cs_early", "https://checkout/early"

    result = await coordinator.create(
        WebhookBeforeReturnCreator(),
        account_id=account_id,
        customer_id=None,
        plan_key="starter",
        interval="month",
        lookup_key="ent_starter_month",
        expected_currency="usd",
        expected_unit_amount=1900,
        expected_interval="month",
        request_key="early-webhook",
    )

    assert result == ("cs_early", "https://checkout/early")
    async with pool.acquire() as conn:
        account = await conn.fetchrow(
            "select stripe_subscription_id from billing_accounts where id=$1::uuid",
            account_id,
        )
        claims = await conn.fetchval(
            "select count(*) from checkout_claims where account_id=$1::uuid", account_id
        )
    assert account is not None and account["stripe_subscription_id"] == "sub_early"
    assert claims == 0
