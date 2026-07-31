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
    assert await coordinator.attach_session(
        claim, "cs_current", "https://checkout/current"
    )
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
