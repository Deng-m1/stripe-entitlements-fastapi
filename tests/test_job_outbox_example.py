from __future__ import annotations

import asyncio
from dataclasses import replace
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import asyncpg
import pytest

from examples.job_outbox.demo import ensure_example_schema, run_demo
from examples.job_outbox.workflow import (
    BillingOutboxWorker,
    DispatchMessage,
    DispatchOutboxWorker,
    JobWorkflowStore,
    QueueConsumer,
)
from stripe_entitlements.catalog import PlanCatalog
from stripe_entitlements.credit_amount import CreditAmount
from stripe_entitlements.credits import CreditResult
from stripe_entitlements.entitlements import (
    CreditIdempotencyConflictError,
    CreditOperationNotFoundError,
    EntitlementService,
)

ROOT = Path(__file__).parents[1]
SCHEMA = (ROOT / "examples" / "job_outbox" / "schema.sql").read_text(encoding="utf-8")
DROP_SCHEMA = """
drop table if exists job_example_queue_inbox;
drop table if exists job_example_dispatch_outbox;
drop table if exists job_example_billing_outbox;
drop table if exists job_example_attempts;
drop table if exists job_example_jobs;
drop function if exists job_example_guard_attempt_state();
drop function if exists job_example_guard_job_state();
"""


@pytest.fixture
async def job_store(pool: asyncpg.Pool) -> JobWorkflowStore:
    async with pool.acquire() as connection:
        await connection.execute(DROP_SCHEMA)
        await connection.execute(SCHEMA)
    try:
        yield JobWorkflowStore(pool)
    finally:
        async with pool.acquire() as connection:
            await connection.execute(DROP_SCHEMA)


async def funded_owner(
    pool: asyncpg.Pool,
    *,
    balance_atoms: int = 2_000_000,
    status: str = "active",
    revoked: bool = False,
) -> tuple[str, UUID]:
    owner = f"v1:tenant:{uuid4()}"
    account_id = uuid4()
    async with pool.acquire() as connection:
        await connection.execute(
            """insert into billing_accounts
                   (id,external_ref,plan_key,plan_interval,subscription_status,
                    credits_balance,credit_expires_at,entitlement_revoked)
                 values($1,$2,'starter','month',$3,$4,
                        now()+interval '1 hour',$5)""",
            account_id,
            owner,
            status,
            balance_atoms,
            revoked,
        )
    return owner, account_id


async def ready_job(
    store: JobWorkflowStore,
    service: EntitlementService,
    owner: str,
    *,
    request_key: str | None = None,
    amount: str = "0.25",
) -> tuple[UUID, UUID]:
    submitted = await store.submit_job(
        request_key=request_key or f"request-{uuid4()}",
        owner_external_ref=owner,
        amount=amount,
        payload={"input_key": "document.pdf"},
    )
    assert await BillingOutboxWorker(store, service).run_once() == ["completed"]
    return submitted.job_id, submitted.attempt_id


async def start_execution(
    store: JobWorkflowStore,
    service: EntitlementService,
    owner: str,
) -> tuple[UUID, UUID, Any]:
    job_id, attempt_id = await ready_job(store, service, owner)
    dispatch = (await store.claim_dispatch(limit=1, lease_seconds=30))[0]
    assert await store.finalize_dispatch(dispatch) is True
    outcome, execution = await QueueConsumer(store, execution_lease_seconds=30).consume(
        dispatch.message
    )
    assert outcome == "started"
    assert execution is not None
    return job_id, attempt_id, execution


async def test_runnable_demo_covers_success_failure_refund_and_fencing(
    job_store: JobWorkflowStore,
    pool: asyncpg.Pool,
) -> None:
    del job_store  # The fixture installs and owns the host example schema.

    report = await run_demo(pool)

    assert report["ok"] is True
    assert report["network_calls"] == 0
    assert report["credit_protocol"] == {
        "scale": 1_000_000,
        "opening": "5.000003",
        "opening_atoms": "5000003",
        "final": "3.750002",
        "final_atoms": "3750002",
    }
    assert report["idempotent_submission_replayed"] is True
    assert report["charge_outcomes"] == ["completed", "completed"]
    assert report["dispatch_outcomes"] == ["published", "published"]
    assert report["queue_outcomes"] == ["started", "started"]
    assert report["stale_execution_tokens_rejected"] is True
    assert report["jobs"] == {
        "success": {"job": "succeeded", "attempt": "succeeded"},
        "failure": {"job": "failed", "attempt": "failed_refunded"},
    }
    assert report["cleanup"] == {"requested": True, "completed": True}
    async with pool.acquire() as connection:
        assert await connection.fetchval("select count(*) from job_example_jobs") == 0


async def test_demo_schema_install_is_repeatable(pool: asyncpg.Pool) -> None:
    async with pool.acquire() as connection:
        await connection.execute(DROP_SCHEMA)
    try:
        assert await ensure_example_schema(pool) == "created"
        assert await ensure_example_schema(pool) == "existing"
    finally:
        async with pool.acquire() as connection:
            await connection.execute(DROP_SCHEMA)


async def test_demo_schema_install_rejects_a_partial_schema(pool: asyncpg.Pool) -> None:
    async with pool.acquire() as connection:
        await connection.execute(DROP_SCHEMA)
        await connection.execute("create table job_example_jobs(id uuid primary key)")
    try:
        with pytest.raises(RuntimeError, match="partially installed"):
            await ensure_example_schema(pool)
    finally:
        async with pool.acquire() as connection:
            await connection.execute(DROP_SCHEMA)


async def test_schema_accepts_canonical_exact_amount_and_rejects_ambiguous_forms(
    job_store: JobWorkflowStore,
    pool: asyncpg.Pool,
) -> None:
    owner, _ = await funded_owner(pool)
    submitted = await job_store.submit_job(
        request_key="canonical-amount",
        owner_external_ref=owner,
        amount="0.125000",
        payload={"kind": "convert"},
    )
    replayed = await job_store.submit_job(
        request_key="canonical-amount",
        owner_external_ref=owner,
        amount="0.125",
        payload={"kind": "convert"},
    )
    async with pool.acquire() as connection:
        amount = await connection.fetchrow(
            """select amount_decimal,amount_atoms
                 from job_example_billing_outbox where attempt_id=$1""",
            submitted.attempt_id,
        )
    assert (amount["amount_decimal"], amount["amount_atoms"]) == ("0.125", 125_000)
    assert replayed == replace(submitted, created=False)

    with pytest.raises(ValueError, match="exact decimal string"):
        await job_store.submit_job(
            request_key="float-amount",
            owner_external_ref=owner,
            amount=0.125,  # type: ignore[arg-type]
            payload={},
        )
    with pytest.raises(ValueError, match="different parameters"):
        await job_store.submit_job(
            request_key="canonical-amount",
            owner_external_ref=owner,
            amount="0.125001",
            payload={"kind": "convert"},
        )

    invalid_values = ["1x2", "1e2", "1.0", "123456789012345678901234567890123"]
    for value in invalid_values:
        with pytest.raises(asyncpg.PostgresError):
            async with pool.acquire() as connection, connection.transaction():
                await connection.execute(
                    """update job_example_billing_outbox
                          set amount_decimal=$2,amount_atoms=1000000 where attempt_id=$1""",
                    submitted.attempt_id,
                    value,
                )
    with pytest.raises(asyncpg.CheckViolationError):
        async with pool.acquire() as connection, connection.transaction():
            await connection.execute(
                """update job_example_billing_outbox set amount_atoms=124999
                    where attempt_id=$1""",
                submitted.attempt_id,
            )
    with pytest.raises(asyncpg.RaiseError, match="invalid job state transition"):
        async with pool.acquire() as connection, connection.transaction():
            await connection.execute(
                "update job_example_jobs set state='succeeded' where id=$1",
                submitted.job_id,
            )


async def test_schema_rejects_cross_wired_job_owner_attempt_and_dispatch_edges(
    job_store: JobWorkflowStore,
    pool: asyncpg.Pool,
) -> None:
    owner_a, _ = await funded_owner(pool)
    owner_b, _ = await funded_owner(pool)
    first = await job_store.submit_job(
        request_key="cross-wire-a",
        owner_external_ref=owner_a,
        amount="0.25",
        payload={"input_key": "a.pdf"},
    )
    second = await job_store.submit_job(
        request_key="cross-wire-b",
        owner_external_ref=owner_b,
        amount="0.5",
        payload={"input_key": "b.pdf"},
    )
    first_dispatch = uuid4()
    second_dispatch = uuid4()

    async with pool.acquire() as connection:
        for statement, arguments in (
            (
                """update job_example_billing_outbox set job_id=$2
                     where attempt_id=$1 and operation='charge'""",
                (first.attempt_id, second.job_id),
            ),
            (
                """update job_example_billing_outbox set owner_external_ref=$2
                     where attempt_id=$1 and operation='charge'""",
                (first.attempt_id, owner_b),
            ),
            (
                """update job_example_billing_outbox set credit_key=$2
                     where attempt_id=$1 and operation='charge'""",
                (first.attempt_id, "job:v1:cross-wired-credit"),
            ),
        ):
            with pytest.raises(asyncpg.ForeignKeyViolationError):
                async with connection.transaction():
                    await connection.execute(statement, *arguments)

        await connection.execute(
            """insert into job_example_dispatch_outbox(id,job_id,attempt_id)
                 values($1,$2,$3),($4,$5,$6)""",
            first_dispatch,
            first.job_id,
            first.attempt_id,
            second_dispatch,
            second.job_id,
            second.attempt_id,
        )
        with pytest.raises(asyncpg.ForeignKeyViolationError):
            async with connection.transaction():
                await connection.execute(
                    "update job_example_dispatch_outbox set job_id=$2 where id=$1",
                    first_dispatch,
                    second.job_id,
                )
        with pytest.raises(asyncpg.ForeignKeyViolationError):
            async with connection.transaction():
                await connection.execute(
                    """insert into job_example_queue_inbox(dispatch_id,attempt_id,outcome)
                         values($1,$2,'consumed')""",
                    first_dispatch,
                    second.attempt_id,
                )


async def test_concurrent_same_request_submission_creates_one_job_and_one_charge(
    job_store: JobWorkflowStore,
    pool: asyncpg.Pool,
) -> None:
    owner, _ = await funded_owner(pool)

    submissions = await asyncio.gather(
        *(
            job_store.submit_job(
                request_key="same-concurrent-request",
                owner_external_ref=owner,
                amount="0.125",
                payload={"input_key": "same.pdf"},
            )
            for _ in range(12)
        )
    )

    assert sum(submission.created for submission in submissions) == 1
    assert {submission.job_id for submission in submissions} == {submissions[0].job_id}
    assert {submission.attempt_id for submission in submissions} == {submissions[0].attempt_id}
    assert {submission.credit_key for submission in submissions} == {submissions[0].credit_key}
    async with pool.acquire() as connection:
        counts = await connection.fetchrow(
            """select
                   (select count(*) from job_example_jobs
                     where request_key='same-concurrent-request') as jobs,
                   (select count(*) from job_example_attempts
                     where job_id=$1) as attempts,
                   (select count(*) from job_example_billing_outbox
                     where job_id=$1 and operation='charge') as charges""",
            submissions[0].job_id,
        )
    assert dict(counts) == {"jobs": 1, "attempts": 1, "charges": 1}


class ObservableBlockingBilling:
    def __init__(self, service: EntitlementService, pool: asyncpg.Pool) -> None:
        self.service = service
        self.pool = pool
        self.entered = asyncio.Event()
        self.release = asyncio.Event()
        self.observed_committed_claim = False

    async def charge(
        self, owner_external_ref: str, amount: str, idempotency_key: str
    ) -> CreditResult:
        async with self.pool.acquire() as connection:
            self.observed_committed_claim = bool(
                await connection.fetchval(
                    """select exists(
                           select 1 from job_example_billing_outbox
                            where credit_key=$1 and state='processing'
                         )""",
                    idempotency_key,
                )
            )
        self.entered.set()
        await self.release.wait()
        return await self.service.charge(owner_external_ref, amount, idempotency_key)

    async def refund(self, owner_external_ref: str, idempotency_key: str) -> CreditResult:
        return await self.service.refund(owner_external_ref, idempotency_key)


async def test_concurrent_skip_locked_workers_commit_claim_before_one_exact_charge(
    job_store: JobWorkflowStore,
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
) -> None:
    owner, account_id = await funded_owner(pool, balance_atoms=1_000_000)
    submitted = await job_store.submit_job(
        request_key="concurrent-charge",
        owner_external_ref=owner,
        amount="0.25",
        payload={"kind": "convert"},
    )
    billing = ObservableBlockingBilling(EntitlementService(pool, catalog), pool)
    first_worker = BillingOutboxWorker(job_store, billing)
    second_worker = BillingOutboxWorker(job_store, billing)

    first = asyncio.create_task(first_worker.run_once(limit=1))
    await asyncio.wait_for(billing.entered.wait(), timeout=5)
    second = await second_worker.run_once(limit=1)
    billing.release.set()
    assert await first == ["completed"]

    assert second == []
    assert billing.observed_committed_claim is True
    async with pool.acquire() as connection:
        snapshot = await connection.fetchrow(
            """select j.state as job_state,a.state as attempt_state,
                      o.state as outbox_state,
                      (select count(*) from credit_debits where idempotency_key=$2) as debits,
                      (select credits_balance from billing_accounts where id=$3) as balance,
                      (select count(*) from job_example_dispatch_outbox
                        where attempt_id=$1) as dispatches
                 from job_example_attempts a
                 join job_example_jobs j on j.id=a.job_id
                 join job_example_billing_outbox o on o.attempt_id=a.id
                where a.id=$1""",
            submitted.attempt_id,
            submitted.credit_key,
            account_id,
        )
    assert dict(snapshot) == {
        "job_state": "ready",
        "attempt_state": "ready",
        "outbox_state": "done",
        "debits": 1,
        "balance": 750_000,
        "dispatches": 1,
    }


async def test_crash_after_charge_replays_and_converges_without_second_debit(
    job_store: JobWorkflowStore,
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
) -> None:
    owner, account_id = await funded_owner(pool)
    submitted = await job_store.submit_job(
        request_key="crash-after-charge",
        owner_external_ref=owner,
        amount="0.5",
        payload={"kind": "convert"},
    )
    service = EntitlementService(pool, catalog)
    crashed_claim = (await job_store.claim_billing(limit=1, lease_seconds=30))[0]
    charged = await service.charge(owner, "0.5", submitted.credit_key)
    assert charged.outcome == "charged"
    async with pool.acquire() as connection:
        await connection.execute(
            """update job_example_billing_outbox
                  set lease_expires_at=clock_timestamp()-interval '1 second'
                where id=$1""",
            crashed_claim.outbox_id,
        )

    assert await BillingOutboxWorker(job_store, service).run_once() == ["completed"]

    async with pool.acquire() as connection:
        evidence = await connection.fetchrow(
            """select
                   (select count(*) from credit_debits where idempotency_key=$1) as debits,
                   (select count(*) from credit_ledger
                     where stripe_event_id='usage:' || $1) as charge_ledger,
                   (select credits_balance from billing_accounts where id=$2) as balance,
                   (select state from job_example_jobs where id=$3) as job_state""",
            submitted.credit_key,
            account_id,
            submitted.job_id,
        )
    assert dict(evidence) == {
        "debits": 1,
        "charge_ledger": 1,
        "balance": 1_500_000,
        "job_state": "ready",
    }


class ChargeThenTimeoutBilling:
    """Model a committed billing effect whose response is lost in transit."""

    def __init__(self, service: EntitlementService) -> None:
        self.service = service
        self.calls = 0

    async def charge(
        self, owner_external_ref: str, amount: str, idempotency_key: str
    ) -> CreditResult:
        self.calls += 1
        result = await self.service.charge(owner_external_ref, amount, idempotency_key)
        if self.calls == 1:
            raise TimeoutError("response lost after commit")
        return result

    async def refund(self, owner_external_ref: str, idempotency_key: str) -> CreditResult:
        return await self.service.refund(owner_external_ref, idempotency_key)


async def test_unknown_charge_response_retries_same_key_and_converges(
    job_store: JobWorkflowStore,
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
) -> None:
    owner, account_id = await funded_owner(pool, balance_atoms=1_000_000)
    submitted = await job_store.submit_job(
        request_key="unknown-charge-response",
        owner_external_ref=owner,
        amount="0.25",
        payload={"kind": "convert"},
    )
    billing = ChargeThenTimeoutBilling(EntitlementService(pool, catalog))
    worker = BillingOutboxWorker(job_store, billing, retry_seconds=0)

    assert await worker.run_once() == ["retry"]
    assert await worker.run_once() == ["completed"]

    async with pool.acquire() as connection:
        evidence = await connection.fetchrow(
            """select o.attempts,o.result_outcome,j.state as job_state,
                      (select count(*) from credit_debits where idempotency_key=$2) as debits,
                      (select credits_balance from billing_accounts where id=$3) as balance
                 from job_example_billing_outbox o
                 join job_example_jobs j on j.id=o.job_id
                where o.attempt_id=$1 and o.operation='charge'""",
            submitted.attempt_id,
            submitted.credit_key,
            account_id,
        )
    assert dict(evidence) == {
        "attempts": 2,
        "result_outcome": "replayed",
        "job_state": "ready",
        "debits": 1,
        "balance": 750_000,
    }


async def test_concurrent_jobs_cannot_overdraw_one_owner(
    job_store: JobWorkflowStore,
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
) -> None:
    owner, account_id = await funded_owner(pool, balance_atoms=500_000)
    submissions = [
        await job_store.submit_job(
            request_key=f"competing-job-{index}",
            owner_external_ref=owner,
            amount="0.5",
            payload={"index": index},
        )
        for index in range(2)
    ]
    first = (await job_store.claim_billing(limit=1, lease_seconds=30))[0]
    second = (await job_store.claim_billing(limit=1, lease_seconds=30))[0]
    service = EntitlementService(pool, catalog)

    outcomes = await asyncio.gather(
        BillingOutboxWorker(job_store, service).process_claim(first),
        BillingOutboxWorker(job_store, service).process_claim(second),
    )

    assert sorted(outcomes) == ["completed", "rejected"]
    async with pool.acquire() as connection:
        evidence = await connection.fetchrow(
            """select
                   (select credits_balance from billing_accounts where id=$1) as balance,
                   (select count(*) from credit_debits where account_id=$1) as debits,
                   (select count(*) from job_example_dispatch_outbox
                     where job_id=any($2::uuid[])) as dispatches,
                   (select count(*) from job_example_jobs
                     where id=any($2::uuid[]) and state='billing_rejected') as rejected""",
            account_id,
            [submission.job_id for submission in submissions],
        )
    assert dict(evidence) == {
        "balance": 0,
        "debits": 1,
        "dispatches": 1,
        "rejected": 1,
    }


async def test_lost_billing_lease_cannot_make_job_ready(
    job_store: JobWorkflowStore,
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
) -> None:
    owner, _ = await funded_owner(pool)
    submitted = await job_store.submit_job(
        request_key="billing-lease-loss",
        owner_external_ref=owner,
        amount="0.25",
        payload={},
    )
    stale = (await job_store.claim_billing(limit=1, lease_seconds=30))[0]
    async with pool.acquire() as connection:
        await connection.execute(
            """update job_example_billing_outbox
                  set lease_expires_at=clock_timestamp()-interval '1 second'
                where id=$1""",
            stale.outbox_id,
        )
    current = (await job_store.claim_billing(limit=1, lease_seconds=30))[0]

    assert await job_store.finalize_charge_success(stale, "charged") is False
    async with pool.acquire() as connection:
        assert (
            await connection.fetchval(
                "select state from job_example_jobs where id=$1", submitted.job_id
            )
            == "pending_credit"
        )
    assert (
        await BillingOutboxWorker(job_store, EntitlementService(pool, catalog)).process_claim(
            current
        )
        == "completed"
    )


class RecordingPublisher:
    def __init__(self) -> None:
        self.messages: list[DispatchMessage] = []

    async def publish(self, message: DispatchMessage) -> None:
        self.messages.append(message)


async def test_dispatch_is_at_least_once_and_consumer_business_effect_is_idempotent(
    job_store: JobWorkflowStore,
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
) -> None:
    owner, _ = await funded_owner(pool)
    await ready_job(job_store, EntitlementService(pool, catalog), owner)
    first_claim = (await job_store.claim_dispatch(limit=1, lease_seconds=30))[0]
    publisher = RecordingPublisher()
    await publisher.publish(first_claim.message)  # publish succeeded; dispatcher crashes here
    first_outcome, execution = await QueueConsumer(job_store).consume(first_claim.message)
    assert first_outcome == "started"
    assert execution is not None
    async with pool.acquire() as connection:
        await connection.execute(
            """update job_example_dispatch_outbox
                  set lease_expires_at=clock_timestamp()-interval '1 second'
                where id=$1""",
            first_claim.dispatch_id,
        )

    second_claim = (await job_store.claim_dispatch(limit=1, lease_seconds=30))[0]
    dispatch_worker = DispatchOutboxWorker(job_store, publisher)
    assert await dispatch_worker.process_claim(second_claim) == "published"
    duplicate_outcome, duplicate_execution = await QueueConsumer(job_store).consume(
        second_claim.message
    )

    assert duplicate_outcome == "duplicate"
    assert duplicate_execution is None
    assert publisher.messages == [first_claim.message, first_claim.message]
    async with pool.acquire() as connection:
        evidence = await connection.fetchrow(
            """select d.delivery_attempts,d.state,a.execution_generation,
                      (select count(*) from job_example_queue_inbox
                        where dispatch_id=d.id) as inbox_rows
                 from job_example_dispatch_outbox d
                 join job_example_attempts a on a.id=d.attempt_id
                where d.id=$1""",
            first_claim.dispatch_id,
        )
    assert dict(evidence) == {
        "delivery_attempts": 2,
        "state": "done",
        "execution_generation": 1,
        "inbox_rows": 1,
    }


async def test_consumer_rejects_unknown_or_not_yet_published_dispatch(
    job_store: JobWorkflowStore,
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
) -> None:
    owner, _ = await funded_owner(pool)
    _, attempt_id = await ready_job(job_store, EntitlementService(pool, catalog), owner)
    async with pool.acquire() as connection:
        pending_id = UUID(
            str(
                await connection.fetchval(
                    "select id from job_example_dispatch_outbox where attempt_id=$1",
                    attempt_id,
                )
            )
        )
    consumer = QueueConsumer(job_store)

    assert await consumer.consume(DispatchMessage(uuid4())) == ("stale", None)
    assert await consumer.consume(DispatchMessage(pending_id)) == ("stale", None)
    claim = (await job_store.claim_dispatch(limit=1, lease_seconds=30))[0]
    outcome, execution = await consumer.consume(claim.message)
    assert outcome == "started"
    assert execution is not None


async def test_execution_heartbeat_and_reclaim_fence_stale_worker_completion(
    job_store: JobWorkflowStore,
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
) -> None:
    owner, _ = await funded_owner(pool)
    _, attempt_id, execution = await start_execution(
        job_store, EntitlementService(pool, catalog), owner
    )
    forged = replace(execution, execution_token=uuid4())

    assert await job_store.renew_execution(execution, lease_seconds=30) is True
    assert await job_store.renew_execution(forged, lease_seconds=30) is False
    assert await job_store.complete_execution(forged) is False
    async with pool.acquire() as connection:
        await connection.execute(
            """update job_example_attempts
                  set execution_lease_expires_at=clock_timestamp()-interval '1 second'
                where id=$1""",
            attempt_id,
        )
    assert await job_store.renew_execution(execution, lease_seconds=30) is False
    assert await job_store.complete_execution(execution) is False

    replacement = await job_store.reclaim_execution(attempt_id, lease_seconds=30)
    assert replacement is not None
    assert replacement.execution_token != execution.execution_token
    assert replacement.generation == execution.generation + 1
    assert await job_store.complete_execution(execution) is False
    assert await job_store.renew_execution(replacement, lease_seconds=30) is True
    assert await job_store.complete_execution(replacement) is True
    async with pool.acquire() as connection:
        states = await connection.fetchrow(
            """select j.state as job_state,a.state as attempt_state
                 from job_example_jobs j join job_example_attempts a on a.job_id=j.id
                where a.id=$1""",
            attempt_id,
        )
    assert dict(states) == {"job_state": "succeeded", "attempt_state": "succeeded"}


async def test_terminal_failure_fences_execution_then_concurrent_refund_converges_once(
    job_store: JobWorkflowStore,
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
) -> None:
    owner, account_id = await funded_owner(pool, balance_atoms=2_000_000)
    job_id, attempt_id, execution = await start_execution(
        job_store, EntitlementService(pool, catalog), owner
    )
    failed = await asyncio.gather(
        job_store.fail_execution(execution, reason="conversion_failed"),
        job_store.fail_execution(execution, reason="conversion_failed"),
    )
    assert sorted(failed) == [False, True]
    async with pool.acquire() as connection:
        fenced = await connection.fetchrow(
            """select j.state as job_state,a.state as attempt_state,a.execution_token,
                      (select count(*) from job_example_billing_outbox
                        where attempt_id=a.id and operation='refund') as refunds
                 from job_example_jobs j join job_example_attempts a on a.job_id=j.id
                where j.id=$1""",
            job_id,
        )
    assert dict(fenced) == {
        "job_state": "refund_pending",
        "attempt_state": "failed_pending_refund",
        "execution_token": None,
        "refunds": 1,
    }

    stale_refund = (await job_store.claim_billing(limit=1, lease_seconds=30))[0]
    async with pool.acquire() as connection:
        await connection.execute(
            """update job_example_billing_outbox
                  set lease_expires_at=clock_timestamp()-interval '1 second'
                where id=$1""",
            stale_refund.outbox_id,
        )
    current_refund = (await job_store.claim_billing(limit=1, lease_seconds=30))[0]
    worker = BillingOutboxWorker(job_store, EntitlementService(pool, catalog))
    outcomes = await asyncio.gather(
        worker.process_claim(stale_refund),
        worker.process_claim(current_refund),
    )
    assert sorted(outcomes) == ["completed", "lease_lost"]

    async with pool.acquire() as connection:
        credit_key = await connection.fetchval(
            "select credit_key from job_example_attempts where id=$1", attempt_id
        )
        converged = await connection.fetchrow(
            """select
                   (select credits_balance from billing_accounts where id=$1) as balance,
                   (select count(*) from credit_ledger
                     where stripe_event_id='usage-refund:' || $2) as refund_ledger,
                   (select state from job_example_jobs where id=$3) as job_state,
                   (select state from job_example_attempts where id=$4) as attempt_state,
                   (select count(*) from job_example_billing_outbox
                     where attempt_id=$4 and operation='refund') as refund_outbox_rows""",
            account_id,
            credit_key,
            job_id,
            attempt_id,
        )
    assert dict(converged) == {
        "balance": 2_000_000,
        "refund_ledger": 1,
        "job_state": "failed",
        "attempt_state": "failed_refunded",
        "refund_outbox_rows": 1,
    }


@pytest.mark.parametrize(
    ("balance_atoms", "status", "expected_error"),
    [
        (0, "active", "InsufficientCreditsError"),
        (5_000_000, "past_due", "CreditsUnavailableError"),
    ],
)
async def test_insufficient_or_unavailable_credits_reject_without_dispatch_or_debit(
    job_store: JobWorkflowStore,
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    balance_atoms: int,
    status: str,
    expected_error: str,
) -> None:
    owner, _ = await funded_owner(pool, balance_atoms=balance_atoms, status=status)
    submitted = await job_store.submit_job(
        request_key=f"billing-rejected-{status}",
        owner_external_ref=owner,
        amount="1",
        payload={},
    )

    assert await BillingOutboxWorker(job_store, EntitlementService(pool, catalog)).run_once() == [
        "rejected"
    ]

    async with pool.acquire() as connection:
        evidence = await connection.fetchrow(
            """select j.state as job_state,a.state as attempt_state,
                      o.state as outbox_state,o.result_outcome,o.attempts,
                      (select count(*) from credit_debits
                        where idempotency_key=a.credit_key) as debits,
                      (select count(*) from job_example_dispatch_outbox
                        where attempt_id=a.id) as dispatches
                 from job_example_jobs j
                 join job_example_attempts a on a.job_id=j.id
                 join job_example_billing_outbox o on o.attempt_id=a.id
                where j.id=$1""",
            submitted.job_id,
        )
    assert dict(evidence) == {
        "job_state": "billing_rejected",
        "attempt_state": "billing_rejected",
        "outbox_state": "done",
        "result_outcome": expected_error,
        "attempts": 1,
        "debits": 0,
        "dispatches": 0,
    }


class PermanentFailureBilling:
    def __init__(self, *, fail_operation: str) -> None:
        self.fail_operation = fail_operation

    async def charge(
        self, owner_external_ref: str, amount: str, idempotency_key: str
    ) -> CreditResult:
        del owner_external_ref, amount, idempotency_key
        if self.fail_operation == "charge":
            raise CreditIdempotencyConflictError("permanent")
        return CreditResult("charged", CreditAmount.from_atoms(0))

    async def refund(self, owner_external_ref: str, idempotency_key: str) -> CreditResult:
        del owner_external_ref, idempotency_key
        raise CreditOperationNotFoundError("permanent")


async def test_permanent_credit_invariant_does_not_retry_forever(
    job_store: JobWorkflowStore,
    pool: asyncpg.Pool,
) -> None:
    owner, _ = await funded_owner(pool)
    charge_submission = await job_store.submit_job(
        request_key="permanent-charge-conflict",
        owner_external_ref=owner,
        amount="0.25",
        payload={},
    )
    charge_worker = BillingOutboxWorker(job_store, PermanentFailureBilling(fail_operation="charge"))
    assert await charge_worker.run_once() == ["rejected"]
    assert await charge_worker.run_once() == []
    async with pool.acquire() as connection:
        charge = await connection.fetchrow(
            """select state,result_outcome,attempts
                 from job_example_billing_outbox
                where attempt_id=$1 and operation='charge'""",
            charge_submission.attempt_id,
        )
    assert dict(charge) == {
        "state": "done",
        "result_outcome": "CreditIdempotencyConflictError",
        "attempts": 1,
    }


async def test_permanent_refund_invariant_stops_for_manual_review_without_false_success(
    job_store: JobWorkflowStore,
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
) -> None:
    owner, account_id = await funded_owner(pool, balance_atoms=2_000_000)
    job_id, attempt_id, execution = await start_execution(
        job_store, EntitlementService(pool, catalog), owner
    )
    assert await job_store.fail_execution(execution, reason="product_failed") is True
    worker = BillingOutboxWorker(job_store, PermanentFailureBilling(fail_operation="refund"))

    assert await worker.run_once() == ["manual_review"]
    assert await worker.run_once() == []

    async with pool.acquire() as connection:
        evidence = await connection.fetchrow(
            """select j.state as job_state,a.state as attempt_state,
                      o.state as outbox_state,o.result_outcome,o.last_error,o.attempts,
                      (select credits_balance from billing_accounts where id=$2) as balance
                 from job_example_jobs j
                 join job_example_attempts a on a.job_id=j.id
                 join job_example_billing_outbox o
                   on o.attempt_id=a.id and o.operation='refund'
                where j.id=$1 and a.id=$3""",
            job_id,
            account_id,
            attempt_id,
        )
    assert dict(evidence) == {
        "job_state": "refund_pending",
        "attempt_state": "failed_pending_refund",
        "outbox_state": "failed",
        "result_outcome": "manual_review",
        "last_error": "CreditOperationNotFoundError",
        "attempts": 1,
        "balance": 1_750_000,
    }
