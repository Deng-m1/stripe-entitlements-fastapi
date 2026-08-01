from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime
from typing import Any

import asyncpg

from stripe_entitlements.processor import EventProcessor
from stripe_entitlements.reconcile import ReconciliationService
from tests.builders import paid_invoice, prorated_upgrade_invoice


class FakeGateway:
    def __init__(
        self,
        account_id: str,
        *,
        status: str = "active",
        invoice_id: str = "in_reconcile",
    ) -> None:
        self.account_id = account_id
        self.status = status
        self.invoice_id = invoice_id

    async def subscription_object(self, subscription_id: str) -> dict[str, Any]:
        return {
            "id": subscription_id,
            "customer": "cus_test",
            "status": self.status,
            "canceled_at": 1_800_000_100 if self.status == "canceled" else None,
            "livemode": False,
            "metadata": {"account_id": self.account_id},
            "items": {
                "data": [
                    {
                        "price": {
                            "id": "price_starter_month",
                            "lookup_key": "ent_starter_month",
                        }
                    }
                ]
            },
        }

    async def latest_paid_invoice_event(self, subscription_id: str) -> dict[str, Any] | None:
        payload = paid_invoice(
            self.account_id,
            invoice_id=self.invoice_id,
            subscription=subscription_id,
            event_id=f"reconcile:{self.invoice_id}",
            created=100,
        )
        payload["_remote_verified"] = True
        return payload


class FakeDeltaGateway(FakeGateway):
    async def subscription_object(self, subscription_id: str) -> dict[str, Any]:
        payload = await super().subscription_object(subscription_id)
        payload["items"]["data"][0]["price"] = {
            "id": "price_pro_month",
            "lookup_key": "ent_pro_month",
        }
        return payload

    async def latest_paid_invoice_event(self, subscription_id: str) -> dict[str, Any] | None:
        payload = prorated_upgrade_invoice(
            self.account_id,
            invoice_id=self.invoice_id,
            subscription=subscription_id,
            event_id=f"reconcile:{self.invoice_id}",
            created=200,
        )
        payload["_remote_verified"] = True
        return payload


async def test_reconcile_recovers_lost_paid_event_even_after_newer_local_failure(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    async with pool.acquire() as conn:
        await conn.execute(
            """update billing_accounts set subscription_status='past_due',
                 event_created=999,event_rank=10 where id=$1::uuid""",
            account_id,
        )
    service = ReconciliationService(pool, processor, FakeGateway(account_id))
    result = await service.reconcile_account(account_id)
    assert result.outcome == "handled"
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "select subscription_status,credits_balance from billing_accounts where id=$1::uuid",
            account_id,
        )
    assert row is not None and tuple(row) == ("active", 300)


async def test_reconcile_remote_cancellation_clears_local_entitlement(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    await processor.process(paid_invoice(account_id, event_id="evt_before_remote_cancel"))
    service = ReconciliationService(pool, processor, FakeGateway(account_id, status="canceled"))
    result = await service.reconcile_account(account_id)
    assert result.outcome == "handled"
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """select plan_key,subscription_status,credits_balance
                 from billing_accounts where id=$1::uuid""",
            account_id,
        )
    assert row is not None and tuple(row) == ("free", "canceled", 0)


async def test_reconcile_cancellation_cas_race_gets_a_new_synthetic_event_id(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    await processor.process(paid_invoice(account_id, event_id="evt_before_cancel_race"))
    gateway = FakeGateway(account_id, status="canceled")
    original = gateway.subscription_object
    raced = False

    async def subscription_with_one_race(subscription_id: str) -> dict[str, Any]:
        nonlocal raced
        payload = await original(subscription_id)
        if not raced:
            raced = True
            async with pool.acquire() as conn:
                await conn.execute(
                    """update billing_accounts set event_created=event_created+1
                         where id=$1::uuid""",
                    account_id,
                )
        return payload

    gateway.subscription_object = subscription_with_one_race  # type: ignore[method-assign]
    service = ReconciliationService(pool, processor, gateway)
    first = await service.reconcile_account(account_id)
    second = await service.reconcile_account(account_id)
    assert first.outcome == "ignored"
    assert second.outcome == "handled"
    async with pool.acquire() as conn:
        account = await conn.fetchrow(
            "select plan_key,subscription_status from billing_accounts where id=$1::uuid",
            account_id,
        )
        synthetic_ids = await conn.fetch(
            """select id from stripe_webhook_events
                 where id like 'reconcile:%:deleted:%' order by id"""
        )
    assert account is not None and tuple(account) == ("free", "canceled")
    assert len(synthetic_ids) == 2


async def test_candidate_scan_includes_stale_plan_change_projection(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    async with pool.acquire() as conn:
        account = await conn.fetchrow(
            "select * from billing_accounts where id=$1::uuid", account_id
        )
        assert account is not None
        change_id = uuid.uuid4()
        await conn.execute(
            """insert into billing_plan_changes(
                   id,account_id,idempotency_key,stripe_subscription_id,
                   from_plan_key,from_interval,target_plan_key,target_interval,
                   effective_mode,status,stripe_request_key,expected_grant_epoch,
                   expected_entitlement_period_end,expected_subscription_status,
                   expected_cancel_at_period_end,updated_at)
                 values($1,$2::uuid,'candidate','sub_test','starter','month',
                        'pro','month','immediate','applying',$3,$4,$5,$6,false,
                        $7::timestamptz-interval '10 minutes')""",
            change_id,
            account_id,
            f"plan-change:{change_id}",
            account["grant_epoch"],
            account["entitlement_period_end"],
            account["subscription_status"],
            datetime(2026, 8, 1, tzinfo=UTC),
        )
    service = ReconciliationService(pool, processor, FakeGateway(account_id))
    candidates = await service.candidates(datetime(2026, 8, 1, tzinfo=UTC))
    assert [str(candidate["id"]) for candidate in candidates] == [account_id]


async def test_many_reconcilers_share_business_idempotency(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    service = ReconciliationService(
        pool, processor, FakeGateway(account_id, invoice_id="in_reconcile_race")
    )
    results = await asyncio.gather(*(service.reconcile_account(account_id) for _ in range(20)))
    assert sum(result.outcome == "handled" for result in results) == 1
    assert sum(result.outcome in {"duplicate", "replayed"} for result in results) == 19
    async with pool.acquire() as conn:
        assert (
            await conn.fetchval(
                "select credits_balance from billing_accounts where id=$1::uuid", account_id
            )
            == 300
        )


async def test_candidate_scan_includes_past_due_accounts(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    async with pool.acquire() as conn:
        await conn.execute(
            "update billing_accounts set subscription_status='past_due' where id=$1::uuid",
            account_id,
        )
    service = ReconciliationService(pool, processor, FakeGateway(account_id))
    candidates = await service.candidates(datetime(2026, 7, 31, tzinfo=UTC))
    assert [str(candidate["id"]) for candidate in candidates] == [account_id]


async def test_candidate_rotation_does_not_starve_accounts_beyond_batch_limit(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_ids = []
    for index in range(105):
        account_id = await make_account(
            customer=f"cus_rotation_{index}",
            subscription=f"sub_rotation_{index}",
        )
        account_ids.append(account_id)
    async with pool.acquire() as conn:
        await conn.execute("update billing_accounts set subscription_status='past_due'")
    now = datetime(2026, 8, 1, tzinfo=UTC)
    service = ReconciliationService(pool, processor, FakeGateway(account_ids[0]))
    first = await service.candidates(now, limit=100, attempted_before=now)
    assert len(first) == 100
    async with pool.acquire() as conn:
        await conn.execute(
            """update billing_accounts set last_reconciled_at=$2
                 where id=any($1::uuid[])""",
            [row["id"] for row in first],
            now,
        )
    second = await service.candidates(now, limit=100, attempted_before=now)
    assert len(second) == 5
    assert {str(row["id"]) for row in first + second} == set(account_ids)


async def test_reconcile_recovers_lost_prorated_delta_invoice(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    assert (
        await processor.process(
            paid_invoice(
                account_id,
                invoice_id="in_reconcile_delta_source",
                period_start=1_800_000_000,
                period_end=1_802_592_000,
                created=100,
            )
        )
    ).outcome == "handled"
    change_id = uuid.uuid4()
    async with pool.acquire() as conn:
        account = await conn.fetchrow(
            "select * from billing_accounts where id=$1::uuid", account_id
        )
        assert account is not None
        await conn.execute(
            """insert into billing_plan_changes(
                   id,account_id,idempotency_key,stripe_subscription_id,
                   from_plan_key,from_interval,target_plan_key,target_interval,
                   effective_mode,status,stripe_request_key,expected_grant_epoch,
                   expected_entitlement_period_end,expected_subscription_status,
                   expected_cancel_at_period_end,transition_policy,
                   expected_source_invoice_id,expected_credit_delta,
                   expected_entitlement_revoked,proration_date,
                   estimated_source_proration,estimated_target_proration,
                   estimated_amount_due,estimated_period_start,
                   estimated_period_end,estimate_currency)
                 values($1,$2::uuid,'reconcile-delta','sub_test','starter','month',
                        'pro','month','immediate','applied',$3,$4,$5,$6,false,
                        'prorated_delta','in_reconcile_delta_source',700,false,
                        1801000000,950,2450,1500,
                        to_timestamp(1801000000),$5,'usd')""",
            change_id,
            account_id,
            f"plan-change:{change_id}",
            account["grant_epoch"],
            account["entitlement_period_end"],
            account["subscription_status"],
        )
    service = ReconciliationService(
        pool,
        processor,
        FakeDeltaGateway(account_id, invoice_id="in_reconcile_delta_upgrade"),
    )
    result = await service.reconcile_account(account_id)
    assert result.outcome == "handled"
    async with pool.acquire() as conn:
        account = await conn.fetchrow(
            "select plan_key,credits_balance from billing_accounts where id=$1::uuid",
            account_id,
        )
        allocation = await conn.fetchrow(
            """select source_invoice_id,entitlement_delta
                 from billing_funding_allocations
                 where stripe_invoice_id='in_reconcile_delta_upgrade'"""
        )
    assert account is not None and tuple(account) == ("pro", 1000)
    assert allocation is not None and tuple(allocation) == (
        "in_reconcile_delta_source",
        700,
    )
