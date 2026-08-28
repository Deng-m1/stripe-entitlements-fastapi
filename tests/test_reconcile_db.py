from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import asyncpg
import pytest

from stripe_entitlements.processor import EventProcessor
from stripe_entitlements.reconcile import ReconciliationService, _projection_committed
from stripe_entitlements.types import ProcessResult
from tests.builders import (
    paid_invoice,
    payment_failed,
    prorated_upgrade_invoice,
    resolved_price,
    subscription_event,
)
from tests.credit_helpers import PRO_CREDITS, STARTER_CREDITS, atoms


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
            "current_period_end": 1_802_592_000,
            "cancel_at_period_end": False,
            "livemode": False,
            "metadata": {
                "account_id": self.account_id,
                "product_line": "example-entitlements",
            },
            "items": {
                "data": [
                    {
                        "quantity": 1,
                        "current_period_end": 1_802_592_000,
                        "price": {
                            "id": "price_starter_month",
                            "lookup_key": "ent_starter_month",
                        },
                        "_resolved_price": resolved_price("starter", "month"),
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


@pytest.mark.parametrize(
    ("result", "expected"),
    [
        (ProcessResult("handled"), True),
        (ProcessResult("replayed"), True),
        (ProcessResult("duplicate", "event id already committed"), False),
        (ProcessResult("duplicate", "event id was reused with a conflicting payload"), False),
        (ProcessResult("ignored", "remote CAS lost"), False),
    ],
)
def test_projection_committed_distinguishes_safe_and_conflicting_duplicates(
    result: ProcessResult, expected: bool
) -> None:
    assert _projection_committed(result) is expected


class FailingGateway(FakeGateway):
    async def subscription_object(self, subscription_id: str) -> dict[str, Any]:
        del subscription_id
        raise TimeoutError("simulated Stripe outage")


class FakeDeltaGateway(FakeGateway):
    async def subscription_object(self, subscription_id: str) -> dict[str, Any]:
        payload = await super().subscription_object(subscription_id)
        payload["items"]["data"][0]["price"] = {
            "id": "price_pro_month",
            "lookup_key": "ent_pro_month",
        }
        payload["items"]["data"][0]["_resolved_price"] = resolved_price("pro", "month")
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


async def test_reconcile_gateway_failure_is_incident_and_still_raises(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    service = ReconciliationService(pool, processor, FailingGateway(account_id))
    with pytest.raises(TimeoutError, match="simulated Stripe outage"):
        await service.reconcile_account(account_id)
    async with pool.acquire() as conn:
        incident = await conn.fetchrow(
            """select detail from billing_incidents
                 where kind='reconciliation_failed'"""
        )
    assert incident is not None
    assert incident["detail"] == {"reason": "subscription retrieval failed: TimeoutError"}


@pytest.mark.parametrize(
    ("malformation", "reason"),
    [
        ("subscription_id", "Stripe returned a different subscription"),
        ("status", "Stripe returned an invalid subscription status"),
        ("livemode", "Stripe returned an invalid subscription mode"),
        ("canceled_at", "Stripe returned an invalid cancellation timestamp"),
    ],
)
async def test_reconcile_rejects_malformed_remote_subscription_contract(
    malformation: str,
    reason: str,
    processor: EventProcessor,
    pool: asyncpg.Pool,
    make_account,
) -> None:
    account_id = await make_account()

    class MalformedGateway(FakeGateway):
        async def subscription_object(self, subscription_id: str) -> dict[str, Any]:
            payload = await super().subscription_object(subscription_id)
            if malformation == "subscription_id":
                payload["id"] = "sub_other"
            elif malformation == "status":
                payload["status"] = None
            elif malformation == "livemode":
                payload["livemode"] = "false"
            else:
                payload["status"] = "canceled"
                payload["canceled_at"] = "1800000100"
            return payload

    result = await ReconciliationService(
        pool,
        processor,
        MalformedGateway(account_id),
    ).reconcile_account(account_id)
    async with pool.acquire() as conn:
        account = await conn.fetchrow(
            """select stripe_subscription_id,subscription_status,event_created
                 from billing_accounts where id=$1::uuid""",
            account_id,
        )
        incident = await conn.fetchrow(
            """select detail from billing_incidents
                 where kind='reconciliation_failed'"""
        )
    assert result.outcome == "ignored"
    assert result.reason == reason
    assert account is not None and tuple(account) == ("sub_test", "active", 0)
    assert incident is not None and incident["detail"]["reason"] == reason


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
    async with pool.acquire() as conn:
        before = int(await conn.fetchval("select extract(epoch from now())::bigint"))
    result = await service.reconcile_account(account_id)
    assert result.outcome == "handled"
    async with pool.acquire() as conn:
        after = int(await conn.fetchval("select extract(epoch from now())::bigint"))
        row = await conn.fetchrow(
            """select subscription_status,credits_balance,event_created,event_rank
                 from billing_accounts where id=$1::uuid""",
            account_id,
        )
    assert row is not None
    assert (row["subscription_status"], row["credits_balance"], row["event_rank"]) == (
        "active",
        STARTER_CREDITS,
        20,
    )
    assert before <= row["event_created"] <= after

    stale_failure = await processor.process(
        payment_failed(account_id, event_id="evt_stale_after_reconcile", created=500)
    )
    assert stale_failure.outcome == "ignored"
    async with pool.acquire() as conn:
        status = await conn.fetchval(
            "select subscription_status from billing_accounts where id=$1::uuid",
            account_id,
        )
    assert status == "active"


@pytest.mark.parametrize(
    ("inject_on", "new_kind"),
    [
        ("customer.subscription.updated", "event_order_tie"),
        ("invoice.paid", "annual_plan_mismatch"),
    ],
)
async def test_reconcile_does_not_resolve_incident_created_after_attempt_started(
    inject_on: str,
    new_kind: str,
    processor: EventProcessor,
    pool: asyncpg.Pool,
    make_account,
) -> None:
    account_id = await make_account()
    async with pool.acquire() as conn:
        await conn.execute(
            """insert into billing_incidents(kind,dedupe_key,account_id,detail)
                 values('reconciliation_failed',$1,$2::uuid,'{}'::jsonb)""",
            f"old:{account_id}",
            account_id,
        )

    class InjectingProcessor:
        injected = False

        async def process(self, event: dict[str, Any]) -> ProcessResult:
            result = await processor.process(event)
            if not self.injected and event["type"] == inject_on:
                self.injected = True
                async with pool.acquire() as conn:
                    await conn.execute(
                        """insert into billing_incidents(kind,dedupe_key,account_id,detail)
                             values($1,$2,$3::uuid,'{}'::jsonb)""",
                        new_kind,
                        f"new:{account_id}:{new_kind}",
                        account_id,
                    )
            return result

    service = ReconciliationService(
        pool,
        InjectingProcessor(),  # type: ignore[arg-type]
        FakeGateway(account_id, invoice_id=f"in_causal_{new_kind}"),
    )
    result = await service.reconcile_account(account_id)

    assert result.outcome == "handled"
    async with pool.acquire() as conn:
        incidents = await conn.fetch(
            """select kind,dedupe_key,resolved_at from billing_incidents
                 where account_id=$1::uuid order by id""",
            account_id,
        )
    by_dedupe = {row["dedupe_key"]: row for row in incidents}
    assert by_dedupe[f"old:{account_id}"]["resolved_at"] is not None
    assert by_dedupe[f"new:{account_id}:{new_kind}"]["resolved_at"] is None


@pytest.mark.parametrize("preexisting", [False, True])
async def test_reconcile_causal_barrier_uses_incident_write_time_not_transaction_start(
    preexisting: bool,
    processor: EventProcessor,
    pool: asyncpg.Pool,
    make_account,
) -> None:
    account_id = await make_account()
    dedupe_key = f"long-transaction:{account_id}:{preexisting}"
    if preexisting:
        async with pool.acquire() as conn:
            await processor._incident(
                conn,
                "event_order_tie",
                event={"id": "evt_old_incident_observation"},
                dedupe_key=dedupe_key,
                account_id=account_id,
            )

    attempt_recorded = asyncio.Event()
    incident_committed = asyncio.Event()

    class BarrierGateway(FakeGateway):
        async def subscription_object(self, subscription_id: str) -> dict[str, Any]:
            attempt_recorded.set()
            await incident_committed.wait()
            return await super().subscription_object(subscription_id)

    service = ReconciliationService(
        pool,
        processor,
        BarrierGateway(account_id, invoice_id=f"in_long_transaction_{preexisting}"),
    )
    async with pool.acquire() as incident_conn:
        transaction = incident_conn.transaction()
        await transaction.start()
        transaction_started_at = await incident_conn.fetchval("select now()")
        reconcile_task = asyncio.create_task(service.reconcile_account(account_id))
        try:
            await asyncio.wait_for(attempt_recorded.wait(), timeout=5)
            await processor._incident(
                incident_conn,
                "event_order_tie",
                event={"id": "evt_late_incident_observation"},
                dedupe_key=dedupe_key,
                account_id=account_id,
            )
            await transaction.commit()
            incident_committed.set()
            result = await asyncio.wait_for(reconcile_task, timeout=5)
        finally:
            incident_committed.set()
            if not reconcile_task.done():
                reconcile_task.cancel()
                await asyncio.gather(reconcile_task, return_exceptions=True)

    assert result.outcome == "handled"
    async with pool.acquire() as conn:
        observation = await conn.fetchrow(
            """select a.last_reconciled_at,i.last_seen_at,i.resolved_at,i.seen_count
                 from billing_accounts a
                 join billing_incidents i on i.account_id=a.id
                where a.id=$1::uuid and i.kind='event_order_tie' and i.dedupe_key=$2""",
            account_id,
            dedupe_key,
        )
    assert observation is not None
    assert transaction_started_at < observation["last_reconciled_at"]
    assert observation["last_seen_at"] > observation["last_reconciled_at"]
    assert observation["resolved_at"] is None
    assert observation["seen_count"] == (2 if preexisting else 1)


async def test_reconcile_causal_cutoff_keeps_equal_timestamp_fail_closed(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    async with pool.acquire() as conn:
        cutoff = await conn.fetchval("select clock_timestamp()")
        await conn.executemany(
            """insert into billing_incidents(
                   kind,dedupe_key,account_id,detail,last_seen_at)
                 values('event_order_tie',$1,$2::uuid,'{}'::jsonb,$3::timestamptz)""",
            [
                (f"older:{account_id}", account_id, cutoff - timedelta(microseconds=1)),
                (f"equal:{account_id}", account_id, cutoff),
            ],
        )

    service = ReconciliationService(pool, processor, FakeGateway(account_id))
    await service._resolve_status_incidents(account_id, cutoff)

    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """select dedupe_key,resolved_at from billing_incidents
                 where account_id=$1::uuid order by dedupe_key""",
            account_id,
        )
    by_dedupe = {row["dedupe_key"]: row for row in rows}
    assert by_dedupe[f"older:{account_id}"]["resolved_at"] is not None
    assert by_dedupe[f"equal:{account_id}"]["resolved_at"] is None


async def test_reconcile_status_projection_uses_database_clock(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    async with pool.acquire() as conn:
        before = int(await conn.fetchval("select extract(epoch from now())::bigint"))
    result = await ReconciliationService(
        pool,
        processor,
        FakeGateway(account_id, status="past_due"),
    ).reconcile_account(account_id)
    async with pool.acquire() as conn:
        after = int(await conn.fetchval("select extract(epoch from now())::bigint"))
        account = await conn.fetchrow(
            """select subscription_status,event_created,event_rank
                 from billing_accounts where id=$1::uuid""",
            account_id,
        )
    assert result.outcome == "handled"
    assert account is not None
    assert account["subscription_status"] == "past_due"
    assert before <= account["event_created"] <= after
    assert account["event_rank"] == 20


async def test_reconcile_resolves_same_second_subscription_update_tie(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    invoice_id = "in_reconcile_subscription_tie"
    await processor.process(
        paid_invoice(
            account_id, invoice_id=invoice_id, event_id="evt_tie_initial_paid", created=100
        )
    )
    await processor.process(
        subscription_event(
            account_id,
            event_id="evt_tie_first_update",
            created=200,
            cancel_at_period_end=False,
        )
    )
    await processor.process(
        subscription_event(
            account_id,
            event_id="evt_tie_second_update",
            created=200,
            cancel_at_period_end=True,
        )
    )

    class CancelingGateway(FakeGateway):
        async def subscription_object(self, subscription_id: str) -> dict[str, Any]:
            payload = await super().subscription_object(subscription_id)
            payload["cancel_at_period_end"] = True
            return payload

    result = await ReconciliationService(
        pool,
        processor,
        CancelingGateway(account_id, invoice_id=invoice_id),
    ).reconcile_account(account_id)
    async with pool.acquire() as conn:
        account = await conn.fetchrow(
            """select cancel_at_period_end,pending_free_at
                 from billing_accounts where id=$1::uuid""",
            account_id,
        )
        resolved = await conn.fetchval(
            """select resolved_at is not null from billing_incidents
                 where kind='event_order_tie'"""
        )
    assert result.outcome == "replayed"
    assert account is not None and account["cancel_at_period_end"] is True
    assert account["pending_free_at"] is not None
    assert resolved is True


async def test_reconcile_remote_cancellation_clears_local_entitlement(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    await processor.process(paid_invoice(account_id, event_id="evt_before_remote_cancel"))
    async with pool.acquire() as conn:
        await conn.execute(
            """insert into billing_incidents(kind,dedupe_key,account_id,detail)
                 values('reconciliation_failed',$1,$2::uuid,'{}'::jsonb)""",
            f"{account_id}:sub_test",
            account_id,
        )
    service = ReconciliationService(pool, processor, FakeGateway(account_id, status="canceled"))
    result = await service.reconcile_account(account_id)
    assert result.outcome == "handled"
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """select plan_key,subscription_status,credits_balance,event_created,event_rank
                 from billing_accounts where id=$1::uuid""",
            account_id,
        )
        incident = await conn.fetchrow(
            """select resolved_at from billing_incidents
                 where kind='reconciliation_failed'"""
        )
    assert row is not None and tuple(row) == ("free", "canceled", 0, 1_800_000_100, 40)
    assert incident is not None and incident["resolved_at"] is not None


async def test_duplicate_of_ignored_synthetic_event_is_not_projection_success(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    await processor.process(paid_invoice(account_id, event_id="evt_before_ignored_duplicate"))
    async with pool.acquire() as conn:
        account = await conn.fetchrow(
            "select * from billing_accounts where id=$1::uuid", account_id
        )
    assert account is not None
    expected_account = {
        "stripe_subscription_id": "sub_test",
        "event_created": int(account["event_created"]),
        "event_rank": int(account["event_rank"]),
    }
    malformed = subscription_event(
        account_id,
        "customer.subscription.deleted",
        status="canceled",
        event_id="reconcile:ignored-cancellation",
        created=1_800_000_100,
    )
    malformed["_remote_verified"] = True
    malformed["_expected_account"] = expected_account
    malformed["data"]["object"]["customer"] = None
    service = ReconciliationService(pool, processor, FakeGateway(account_id, status="canceled"))

    first = await service._process(malformed, account_id, "sub_test")
    duplicate = await service._process(malformed, account_id, "sub_test")

    assert first.outcome == "ignored"
    assert duplicate.outcome == "ignored"
    assert duplicate.reason == first.reason
    async with pool.acquire() as conn:
        unchanged = await conn.fetchrow(
            "select plan_key,subscription_status from billing_accounts where id=$1::uuid",
            account_id,
        )
    assert unchanged is not None and tuple(unchanged) == ("starter", "active")


async def test_reconcile_retries_corrected_cancellation_after_ignored_delivery(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    await processor.process(paid_invoice(account_id, event_id="evt_before_corrected_cancel"))

    class CorrectableCancellationGateway(FakeGateway):
        customer: str | None = None

        async def subscription_object(self, subscription_id: str) -> dict[str, Any]:
            payload = await super().subscription_object(subscription_id)
            payload["customer"] = self.customer
            return payload

    gateway = CorrectableCancellationGateway(account_id, status="canceled")
    service = ReconciliationService(pool, processor, gateway)
    first = await service.reconcile_account(account_id)
    gateway.customer = "cus_test"
    second = await service.reconcile_account(account_id)

    assert first.outcome == "ignored"
    assert second.outcome == "handled"
    async with pool.acquire() as conn:
        account = await conn.fetchrow(
            """select stripe_subscription_id,plan_key,subscription_status,credits_balance
                 from billing_accounts where id=$1::uuid""",
            account_id,
        )
        deliveries = await conn.fetch(
            """select outcome from stripe_webhook_events
                 where id like 'reconcile:%:deleted:%' order by received_at,id"""
        )
        reconciliation_incident = await conn.fetchrow(
            """select resolved_at from billing_incidents
                 where kind='reconciliation_failed'"""
        )
    assert account is not None and tuple(account) == (None, "free", "canceled", 0)
    assert [row["outcome"] for row in deliveries] == ["ignored", "handled"]
    assert reconciliation_incident is not None
    assert reconciliation_incident["resolved_at"] is not None


async def test_concurrent_identical_ignored_cancellations_use_distinct_attempt_identities(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    await processor.process(paid_invoice(account_id, event_id="evt_before_attempt_identity"))

    class MissingCustomerGateway(FakeGateway):
        async def subscription_object(self, subscription_id: str) -> dict[str, Any]:
            payload = await super().subscription_object(subscription_id)
            payload["customer"] = None
            return payload

    service = ReconciliationService(
        pool,
        processor,
        MissingCustomerGateway(account_id, status="canceled"),
    )
    results = await asyncio.gather(
        service.reconcile_account(account_id),
        service.reconcile_account(account_id),
    )

    assert [result.outcome for result in results] == ["ignored", "ignored"]
    async with pool.acquire() as conn:
        deliveries = await conn.fetch(
            """select id,outcome from stripe_webhook_events
                 where id like 'reconcile:%:deleted:%' order by id"""
        )
    assert len(deliveries) == 2
    assert len({row["id"] for row in deliveries}) == 2
    assert {row["outcome"] for row in deliveries} == {"ignored"}


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
    assert first.outcome == "handled"
    assert second.outcome == "ignored"
    assert second.reason == "account has no subscription"
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


async def test_reconcile_marks_stale_plan_change_for_same_preview_recovery(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    await processor.process(
        paid_invoice(account_id, invoice_id="in_reconcile_recovery_source", created=100)
    )
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
                   expected_cancel_at_period_end,updated_at)
                 values($1,$2::uuid,'recovery-required','sub_test','starter','month',
                        'pro','month','immediate','applying',$3,$4,$5,$6,false,
                        now()-interval '10 minutes')""",
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
        FakeGateway(account_id, invoice_id="in_reconcile_old_funding"),
    )
    result = await service.reconcile_account(account_id)
    async with pool.acquire() as conn:
        incident = await conn.fetchrow(
            """select kind,detail from billing_incidents
                 where kind='plan_change_recovery_required'"""
        )
        status = await conn.fetchval(
            "select status from billing_plan_changes where id=$1::uuid", change_id
        )
    assert result.outcome == "ignored"
    assert status == "applying"
    assert incident is not None
    assert incident["detail"]["plan_change_id"] == str(change_id)
    assert incident["detail"]["status"] == "applying"


@pytest.mark.parametrize("round_id", range(5))
async def test_many_reconcilers_share_business_idempotency(
    round_id: int, processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    service = ReconciliationService(
        pool,
        processor,
        FakeGateway(account_id, invoice_id=f"in_reconcile_race_{round_id}"),
    )
    results = await asyncio.gather(*(service.reconcile_account(account_id) for _ in range(20)))
    observed = [(result.outcome, result.reason) for result in results]
    assert sum(result.outcome == "handled" for result in results) == 1, observed
    assert sum(result.outcome == "replayed" for result in results) == 19, observed
    async with pool.acquire() as conn:
        assert (
            await conn.fetchval(
                "select credits_balance from billing_accounts where id=$1::uuid", account_id
            )
            == STARTER_CREDITS
        )
        unresolved = await conn.fetchval(
            """select count(*) from billing_incidents
                 where account_id=$1::uuid and resolved_at is null
                   and kind in ('stale_paid_event','reconciliation_failed')""",
            account_id,
        )
    assert unresolved == 0


@pytest.mark.parametrize("round_id", range(3))
async def test_cross_epoch_reconcilers_retry_paid_cas_and_resolve_only_failed_attempt(
    round_id: int,
    processor: EventProcessor,
    pool: asyncpg.Pool,
    make_account,
) -> None:
    account_id = await make_account()
    invoice_id = f"in_cross_epoch_reconcile_{round_id}"
    a_paid_ready = asyncio.Event()
    b_paid_ready = asyncio.Event()
    release_a_paid = asyncio.Event()
    release_b_paid = asyncio.Event()

    class PaidBarrierGateway(FakeGateway):
        def __init__(
            self,
            ready: asyncio.Event,
            release: asyncio.Event,
        ) -> None:
            super().__init__(account_id, invoice_id=invoice_id)
            self.ready = ready
            self.release = release

        async def latest_paid_invoice_event(self, subscription_id: str) -> dict[str, Any] | None:
            self.ready.set()
            await self.release.wait()
            return await super().latest_paid_invoice_event(subscription_id)

    service_a = ReconciliationService(
        pool,
        processor,
        PaidBarrierGateway(a_paid_ready, release_a_paid),
    )
    service_b = ReconciliationService(
        pool,
        processor,
        PaidBarrierGateway(b_paid_ready, release_b_paid),
    )
    task_a = asyncio.create_task(service_a.reconcile_account(account_id))
    task_b: asyncio.Task[ProcessResult] | None = None
    try:
        await asyncio.wait_for(a_paid_ready.wait(), timeout=10)
        async with pool.acquire() as conn:
            a_epoch = int(
                await conn.fetchval(
                    "select event_created from billing_accounts where id=$1::uuid",
                    account_id,
                )
            )
        for _ in range(300):
            async with pool.acquire() as conn:
                database_epoch = int(
                    await conn.fetchval("select extract(epoch from clock_timestamp())::bigint")
                )
            if database_epoch > a_epoch:
                break
            await asyncio.sleep(0.01)
        else:
            pytest.fail("database epoch did not advance for the deterministic race")

        task_b = asyncio.create_task(service_b.reconcile_account(account_id))
        await asyncio.wait_for(b_paid_ready.wait(), timeout=10)
        async with pool.acquire() as conn:
            b_epoch = int(
                await conn.fetchval(
                    "select event_created from billing_accounts where id=$1::uuid",
                    account_id,
                )
            )
        assert b_epoch > a_epoch

        release_a_paid.set()
        result_a = await asyncio.wait_for(task_a, timeout=10)
        release_b_paid.set()
        result_b = await asyncio.wait_for(task_b, timeout=10)
    finally:
        release_a_paid.set()
        release_b_paid.set()
        tasks = [task_a, *([task_b] if task_b is not None else [])]
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    observed = [(result_a.outcome, result_a.reason), (result_b.outcome, result_b.reason)]
    assert sum(result.outcome == "handled" for result in (result_a, result_b)) == 1, observed
    assert sum(result.outcome == "replayed" for result in (result_a, result_b)) == 1, observed
    async with pool.acquire() as conn:
        account = await conn.fetchrow(
            """select credits_balance,plan_key,subscription_status
                 from billing_accounts where id=$1::uuid""",
            account_id,
        )
        grant_count = await conn.fetchval(
            """select count(*) from credit_ledger
                 where account_id=$1::uuid and stripe_invoice_id=$2 and grant_slot=1""",
            account_id,
            invoice_id,
        )
        paid_audits = await conn.fetch(
            """select id,outcome from stripe_webhook_events
                 where event_type='invoice.paid' order by id"""
        )
        stale_incident = await conn.fetchrow(
            """select stripe_event_id,resolved_at from billing_incidents
                 where account_id=$1::uuid and invoice_id=$2 and kind='stale_paid_event'""",
            account_id,
            invoice_id,
        )
        unresolved = await conn.fetchval(
            """select count(*) from billing_incidents
                 where account_id=$1::uuid and resolved_at is null
                   and kind in ('stale_paid_event','reconciliation_failed')""",
            account_id,
        )
    assert account is not None and tuple(account) == (STARTER_CREDITS, "starter", "active")
    assert grant_count == 1
    assert [row["outcome"] for row in paid_audits] == ["ignored", "handled"]
    ignored_event_id = next(row["id"] for row in paid_audits if row["outcome"] == "ignored")
    assert stale_incident is not None
    assert stale_incident["stripe_event_id"] == ignored_event_id
    assert stale_incident["resolved_at"] is not None
    assert unresolved == 0


async def test_candidate_scan_uses_database_clock_and_explicit_exclusion(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_ids = [
        await make_account(),
        await make_account(customer="cus_db_clock_2", subscription="sub_db_clock_2"),
    ]
    async with pool.acquire() as conn:
        await conn.execute(
            "update billing_accounts set subscription_status='past_due' where id=any($1::uuid[])",
            account_ids,
        )
        before = await conn.fetchval("select now()")
    service = ReconciliationService(pool, processor, FakeGateway(account_ids[0]))
    database_now = await service.database_now()
    first = await service.candidates(None, limit=1)
    assert len(first) == 1
    excluded = {str(first[0]["id"])}
    second = await service.candidates(None, exclude_account_ids=excluded)
    async with pool.acquire() as conn:
        after = await conn.fetchval("select now()")
    assert before <= database_now <= after
    assert {str(row["id"]) for row in second} == set(account_ids) - excluded


@pytest.mark.parametrize(
    ("now", "attempted_before", "limit"),
    [
        (datetime(2026, 8, 1), None, 100),
        (None, datetime(2026, 8, 1), 100),
        (None, None, 0),
    ],
)
async def test_candidate_scan_rejects_invalid_clock_or_limit(
    now: datetime | None,
    attempted_before: datetime | None,
    limit: int,
    processor: EventProcessor,
    pool: asyncpg.Pool,
) -> None:
    service = ReconciliationService(pool, processor, FakeGateway("unused"))
    with pytest.raises(ValueError):
        await service.candidates(now, attempted_before=attempted_before, limit=limit)


@pytest.mark.parametrize("incident_kind", ["reconciliation_failed", "event_order_tie"])
async def test_candidate_scan_includes_reconciliation_incidents(
    incident_kind: str,
    processor: EventProcessor,
    pool: asyncpg.Pool,
    make_account,
) -> None:
    account_id = await make_account()
    async with pool.acquire() as conn:
        await conn.execute(
            """insert into billing_incidents(kind,dedupe_key,account_id,detail)
                 values($1,$2,$3::uuid,'{}'::jsonb)""",
            incident_kind,
            f"{account_id}:sub_test:{incident_kind}",
            account_id,
        )
    service = ReconciliationService(pool, processor, FakeGateway(account_id))
    candidates = await service.candidates(datetime(2026, 7, 31, tzinfo=UTC))
    assert [str(candidate["id"]) for candidate in candidates] == [account_id]


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
                        'prorated_delta','in_reconcile_delta_source',$7,false,
                        1801000000,950,2450,1500,
                        to_timestamp(1801000000),$5,'usd')""",
            change_id,
            account_id,
            f"plan-change:{change_id}",
            account["grant_epoch"],
            account["entitlement_period_end"],
            account["subscription_status"],
            atoms(700),
        )
        await conn.execute(
            """insert into billing_incidents(kind,dedupe_key,account_id,detail)
                 values('plan_change_recovery_required',$1,$2::uuid,$3::jsonb)""",
            f"{account_id}:{change_id}",
            account_id,
            {"plan_change_id": str(change_id), "status": "applied"},
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
        incident_resolved = await conn.fetchval(
            """select resolved_at is not null from billing_incidents
                 where kind='plan_change_recovery_required'"""
        )
    assert account is not None and tuple(account) == ("pro", PRO_CREDITS)
    assert allocation is not None and tuple(allocation) == (
        "in_reconcile_delta_source",
        atoms(700),
    )
    assert incident_resolved is True
