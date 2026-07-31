from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from typing import Any

import asyncpg

from stripe_entitlements.processor import EventProcessor
from stripe_entitlements.reconcile import ReconciliationService
from tests.builders import paid_invoice


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

    async def latest_paid_invoice_event(
        self, subscription_id: str
    ) -> dict[str, Any] | None:
        payload = paid_invoice(
            self.account_id,
            invoice_id=self.invoice_id,
            subscription=subscription_id,
            event_id=f"reconcile:{self.invoice_id}",
            created=100,
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
    service = ReconciliationService(
        pool, processor, FakeGateway(account_id, status="canceled")
    )
    result = await service.reconcile_account(account_id)
    assert result.outcome == "handled"
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """select plan_key,subscription_status,credits_balance
                 from billing_accounts where id=$1::uuid""",
            account_id,
        )
    assert row is not None and tuple(row) == ("free", "canceled", 0)


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
        assert await conn.fetchval(
            "select credits_balance from billing_accounts where id=$1::uuid", account_id
        ) == 300


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
