from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Literal, Protocol, cast
from uuid import UUID, uuid4

import asyncpg

from stripe_entitlements.credit_amount import CreditAmount
from stripe_entitlements.credits import (
    CreditResult,
    CreditsUnavailableError,
    InsufficientCreditsError,
)
from stripe_entitlements.entitlements import (
    BillingOwnerNotFoundError,
    CreditIdempotencyConflictError,
    CreditOperationNotFoundError,
    EntitlementService,
    InvalidCreditRequestError,
    InvalidOwnerReferenceError,
    validate_owner_external_ref,
)

BillingOperation = Literal["charge", "refund"]
WorkerOutcome = Literal["completed", "rejected", "manual_review", "retry", "lease_lost"]
DispatchOutcome = Literal["published", "retry", "lease_lost"]
ConsumeOutcome = Literal["started", "duplicate", "stale"]

_MAX_BATCH = 100
_MAX_LEASE_SECONDS = 300
_MAX_RETRY_SECONDS = 3_600
_MAX_PAYLOAD_BYTES = 65_536


class WorkflowInvariantError(RuntimeError):
    pass


def _bounded_integer(value: object, *, field: str, lower: int, upper: int) -> int:
    if type(value) is not int or not lower <= value <= upper:
        raise ValueError(f"{field} must be an integer from {lower} to {upper}")
    return value


def _bounded_key(value: object, *, field: str, maximum: int = 200) -> str:
    if (
        type(value) is not str
        or not value
        or value != value.strip()
        or len(value.encode("utf-8")) > maximum
        or any(not character.isprintable() for character in value)
    ):
        raise ValueError(f"{field} must be a bounded visible string")
    return value


def _json_payload(payload: Mapping[str, object]) -> str:
    try:
        encoded = json.dumps(
            dict(payload),
            ensure_ascii=False,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        )
    except (TypeError, ValueError) as exc:
        raise ValueError("payload must be a JSON object with finite values") from exc
    if len(encoded.encode("utf-8")) > _MAX_PAYLOAD_BYTES:
        raise ValueError("payload exceeds 65536 UTF-8 bytes")
    return encoded


@dataclass(frozen=True, slots=True)
class JobSubmission:
    job_id: UUID
    attempt_id: UUID
    credit_key: str
    created: bool


@dataclass(frozen=True, slots=True)
class BillingOutboxClaim:
    outbox_id: UUID
    job_id: UUID
    attempt_id: UUID
    operation: BillingOperation
    owner_external_ref: str
    amount_decimal: str
    amount_atoms: int
    credit_key: str
    attempts: int
    lease_token: UUID


@dataclass(frozen=True, slots=True)
class DispatchOutboxClaim:
    dispatch_id: UUID
    job_id: UUID
    attempt_id: UUID
    delivery_attempts: int
    lease_token: UUID

    @property
    def message(self) -> DispatchMessage:
        return DispatchMessage(self.dispatch_id)


@dataclass(frozen=True, slots=True)
class DispatchMessage:
    dispatch_id: UUID


@dataclass(frozen=True, slots=True)
class ExecutionClaim:
    job_id: UUID
    attempt_id: UUID
    execution_token: UUID
    generation: int
    payload: Mapping[str, Any]


class BillingClient(Protocol):
    async def charge(
        self, owner_external_ref: str, amount: str, idempotency_key: str
    ) -> CreditResult: ...

    async def refund(self, owner_external_ref: str, idempotency_key: str) -> CreditResult: ...


class QueuePublisher(Protocol):
    async def publish(self, message: DispatchMessage) -> None: ...


class JobWorkflowStore:
    """Host transaction boundary; no method here calls billing or a queue."""

    def __init__(self, pool: asyncpg.Pool) -> None:
        self.pool = pool

    async def submit_job(
        self,
        *,
        request_key: str,
        owner_external_ref: str,
        amount: str,
        payload: Mapping[str, object],
    ) -> JobSubmission:
        request_key = _bounded_key(request_key, field="request key")
        owner_external_ref = validate_owner_external_ref(owner_external_ref)
        if type(amount) is not str:
            raise ValueError("amount must be an exact decimal string")
        normalized = CreditAmount.parse(amount, field="job credit amount", allow_zero=False)
        amount_decimal = str(normalized)
        payload_json = _json_payload(payload)
        payload_bytes = payload_json.encode("utf-8")
        job_id = uuid4()
        attempt_id = uuid4()
        credit_key = f"job:v1:{job_id}:attempt:{attempt_id}"
        outbox_id = uuid4()

        async with self.pool.acquire() as connection, connection.transaction():
            inserted = await connection.fetchval(
                """insert into job_example_jobs
                       (id,request_key,owner_external_ref,payload,state)
                     values($1,$2,$3,convert_from($4,'utf8')::jsonb,'pending_credit')
                     on conflict(request_key) do nothing returning id""",
                job_id,
                request_key,
                owner_external_ref,
                payload_bytes,
            )
            if inserted is None:
                existing = await connection.fetchrow(
                    """select j.id,a.id as attempt_id,a.credit_key
                         from job_example_jobs j
                         join job_example_attempts a on a.job_id=j.id
                        where j.request_key=$1 and j.owner_external_ref=$2
                          and j.payload=convert_from($3,'utf8')::jsonb
                          and exists (
                              select 1 from job_example_billing_outbox o
                               where o.attempt_id=a.id and o.operation='charge'
                                 and o.amount_decimal=$4 and o.amount_atoms=$5
                          )""",
                    request_key,
                    owner_external_ref,
                    payload_bytes,
                    amount_decimal,
                    normalized.atoms,
                )
                if existing is None:
                    raise ValueError("request key was already used with different parameters")
                return JobSubmission(
                    UUID(str(existing["id"])),
                    UUID(str(existing["attempt_id"])),
                    str(existing["credit_key"]),
                    False,
                )

            await connection.execute(
                """insert into job_example_attempts(id,job_id,state,credit_key)
                     values($1,$2,'pending_credit',$3)""",
                attempt_id,
                job_id,
                credit_key,
            )
            await connection.execute(
                """insert into job_example_billing_outbox
                       (id,job_id,attempt_id,operation,owner_external_ref,
                        amount_decimal,amount_atoms,credit_key)
                     values($1,$2,$3,'charge',$4,$5,$6,$7)""",
                outbox_id,
                job_id,
                attempt_id,
                owner_external_ref,
                amount_decimal,
                normalized.atoms,
                credit_key,
            )
        return JobSubmission(job_id, attempt_id, credit_key, True)

    async def claim_billing(
        self, *, limit: int = 10, lease_seconds: int = 30
    ) -> list[BillingOutboxClaim]:
        limit = _bounded_integer(limit, field="claim limit", lower=1, upper=_MAX_BATCH)
        lease_seconds = _bounded_integer(
            lease_seconds, field="lease seconds", lower=1, upper=_MAX_LEASE_SECONDS
        )
        lease_token = uuid4()
        async with self.pool.acquire() as connection, connection.transaction():
            rows = await connection.fetch(
                """with candidates as (
                       select o.id
                         from job_example_billing_outbox o
                         join job_example_attempts a on a.id=o.attempt_id
                        where (
                              (o.state='pending' and o.available_at <= clock_timestamp())
                           or (o.state='processing' and o.lease_expires_at <= clock_timestamp())
                        )
                          and (
                              (o.operation='charge'
                               and a.state in ('pending_credit','charging'))
                           or (o.operation='refund' and a.state='failed_pending_refund')
                          )
                        order by o.available_at,o.created_at,o.id
                        for update of o skip locked
                        limit $1
                     )
                     update job_example_billing_outbox o
                        set state='processing',attempts=o.attempts+1,
                            lease_token=$2,
                            lease_expires_at=clock_timestamp()+$3::integer*interval '1 second',
                            updated_at=clock_timestamp()
                       from candidates c where o.id=c.id
                     returning o.*""",
                limit,
                lease_token,
                lease_seconds,
            )
            claims: list[BillingOutboxClaim] = []
            for row in rows:
                operation = str(row["operation"])
                if operation == "charge":
                    attempt = await connection.fetchval(
                        """update job_example_attempts
                              set state='charging',updated_at=clock_timestamp()
                            where id=$1 and state in ('pending_credit','charging')
                            returning id""",
                        row["attempt_id"],
                    )
                    if attempt is None:
                        raise WorkflowInvariantError("charge claim lost its attempt state")
                claims.append(self._billing_claim(row, lease_token))
        return claims

    @staticmethod
    def _billing_claim(row: asyncpg.Record, lease_token: UUID) -> BillingOutboxClaim:
        operation = str(row["operation"])
        if operation not in {"charge", "refund"}:
            raise WorkflowInvariantError("unknown billing operation")
        return BillingOutboxClaim(
            outbox_id=UUID(str(row["id"])),
            job_id=UUID(str(row["job_id"])),
            attempt_id=UUID(str(row["attempt_id"])),
            operation=operation,  # type: ignore[arg-type]
            owner_external_ref=str(row["owner_external_ref"]),
            amount_decimal=str(row["amount_decimal"]),
            amount_atoms=int(row["amount_atoms"]),
            credit_key=str(row["credit_key"]),
            attempts=int(row["attempts"]),
            lease_token=lease_token,
        )

    async def finalize_charge_success(
        self, claim: BillingOutboxClaim, outcome: Literal["charged", "replayed"]
    ) -> bool:
        if claim.operation != "charge":
            raise ValueError("a refund claim cannot finalize a charge")
        dispatch_id = uuid4()
        async with self.pool.acquire() as connection, connection.transaction():
            if not await self._lock_current_billing_claim(connection, claim):
                return False
            attempt = await connection.fetchval(
                """update job_example_attempts
                      set state='ready',updated_at=clock_timestamp()
                    where id=$1 and job_id=$2 and state='charging'
                    returning id""",
                claim.attempt_id,
                claim.job_id,
            )
            if attempt is None:
                raise WorkflowInvariantError("charge finalization found a non-charging attempt")
            job = await connection.fetchval(
                """update job_example_jobs set state='ready',updated_at=clock_timestamp()
                    where id=$1 and state='pending_credit' returning id""",
                claim.job_id,
            )
            if job is None:
                raise WorkflowInvariantError("charge finalization found a non-pending job")
            await connection.execute(
                """insert into job_example_dispatch_outbox(id,job_id,attempt_id)
                     values($1,$2,$3)""",
                dispatch_id,
                claim.job_id,
                claim.attempt_id,
            )
            await self._complete_billing_claim(connection, claim, outcome)
        return True

    async def finalize_charge_rejected(self, claim: BillingOutboxClaim, *, reason: str) -> bool:
        if claim.operation != "charge":
            raise ValueError("a refund claim cannot reject a charge")
        reason = _bounded_key(reason, field="billing rejection", maximum=128)
        async with self.pool.acquire() as connection, connection.transaction():
            if not await self._lock_current_billing_claim(connection, claim):
                return False
            attempt = await connection.fetchval(
                """update job_example_attempts
                      set state='billing_rejected',terminal_reason=$3,
                          updated_at=clock_timestamp()
                    where id=$1 and job_id=$2 and state='charging' returning id""",
                claim.attempt_id,
                claim.job_id,
                reason,
            )
            if attempt is None:
                raise WorkflowInvariantError("billing rejection found a non-charging attempt")
            job = await connection.fetchval(
                """update job_example_jobs
                      set state='billing_rejected',updated_at=clock_timestamp()
                    where id=$1 and state='pending_credit' returning id""",
                claim.job_id,
            )
            if job is None:
                raise WorkflowInvariantError("billing rejection found a non-pending job")
            await self._complete_billing_claim(connection, claim, reason)
        return True

    async def finalize_refund_success(
        self,
        claim: BillingOutboxClaim,
        outcome: Literal["refunded", "replayed", "epoch_expired"],
    ) -> bool:
        if claim.operation != "refund":
            raise ValueError("a charge claim cannot finalize a refund")
        async with self.pool.acquire() as connection, connection.transaction():
            if not await self._lock_current_billing_claim(connection, claim):
                return False
            attempt = await connection.fetchval(
                """update job_example_attempts
                      set state='failed_refunded',updated_at=clock_timestamp()
                    where id=$1 and job_id=$2 and state='failed_pending_refund'
                    returning id""",
                claim.attempt_id,
                claim.job_id,
            )
            if attempt is None:
                raise WorkflowInvariantError("refund finalization found an invalid attempt")
            job = await connection.fetchval(
                """update job_example_jobs set state='failed',updated_at=clock_timestamp()
                    where id=$1 and state='refund_pending' returning id""",
                claim.job_id,
            )
            if job is None:
                raise WorkflowInvariantError("refund finalization found an invalid job")
            await self._complete_billing_claim(connection, claim, outcome)
        return True

    async def _lock_current_billing_claim(
        self, connection: asyncpg.Connection, claim: BillingOutboxClaim
    ) -> bool:
        return bool(
            await connection.fetchval(
                """select exists(
                       select 1 from job_example_billing_outbox
                        where id=$1 and attempt_id=$2 and operation=$3
                          and state='processing' and lease_token=$4
                          and lease_expires_at > clock_timestamp()
                        for update
                     )""",
                claim.outbox_id,
                claim.attempt_id,
                claim.operation,
                claim.lease_token,
            )
        )

    @staticmethod
    async def _complete_billing_claim(
        connection: asyncpg.Connection,
        claim: BillingOutboxClaim,
        result: str,
    ) -> None:
        updated = await connection.fetchval(
            """update job_example_billing_outbox
                  set state='done',result_outcome=$3,last_error=null,
                      completed_at=clock_timestamp(),lease_token=null,
                      lease_expires_at=null,updated_at=clock_timestamp()
                where id=$1 and state='processing' and lease_token=$2
                returning id""",
            claim.outbox_id,
            claim.lease_token,
            result,
        )
        if updated is None:
            raise WorkflowInvariantError("billing lease changed during finalization")

    async def release_billing_claim(
        self, claim: BillingOutboxClaim, *, error: str, retry_seconds: int
    ) -> bool:
        error = _bounded_key(error, field="billing error", maximum=128)
        retry_seconds = _bounded_integer(
            retry_seconds, field="retry seconds", lower=0, upper=_MAX_RETRY_SECONDS
        )
        async with self.pool.acquire() as connection:
            updated = await connection.fetchval(
                """update job_example_billing_outbox
                      set state='pending',available_at=clock_timestamp()
                              +$3::integer*interval '1 second',
                          lease_token=null,lease_expires_at=null,last_error=$4,
                          updated_at=clock_timestamp()
                    where id=$1 and state='processing' and lease_token=$2
                    returning id""",
                claim.outbox_id,
                claim.lease_token,
                retry_seconds,
                error,
            )
        return updated is not None

    async def finalize_billing_permanent_failure(
        self, claim: BillingOutboxClaim, *, error: str
    ) -> bool:
        """Stop retrying an invariant failure without claiming that a refund succeeded."""

        error = _bounded_key(error, field="billing error", maximum=128)
        async with self.pool.acquire() as connection, connection.transaction():
            if not await self._lock_current_billing_claim(connection, claim):
                return False
            updated = await connection.fetchval(
                """update job_example_billing_outbox
                      set state='failed',result_outcome='manual_review',last_error=$3,
                          completed_at=clock_timestamp(),lease_token=null,
                          lease_expires_at=null,updated_at=clock_timestamp()
                    where id=$1 and state='processing' and lease_token=$2
                    returning id""",
                claim.outbox_id,
                claim.lease_token,
                error,
            )
            if updated is None:
                raise WorkflowInvariantError("billing lease changed during failure finalization")
        return True

    async def claim_dispatch(
        self, *, limit: int = 10, lease_seconds: int = 30
    ) -> list[DispatchOutboxClaim]:
        limit = _bounded_integer(limit, field="claim limit", lower=1, upper=_MAX_BATCH)
        lease_seconds = _bounded_integer(
            lease_seconds, field="lease seconds", lower=1, upper=_MAX_LEASE_SECONDS
        )
        lease_token = uuid4()
        async with self.pool.acquire() as connection, connection.transaction():
            rows = await connection.fetch(
                """with candidates as (
                       select id from job_example_dispatch_outbox
                        where (state='pending' and available_at <= clock_timestamp())
                           or (state='processing' and lease_expires_at <= clock_timestamp())
                        order by available_at,created_at,id
                        for update skip locked limit $1
                     )
                     update job_example_dispatch_outbox o
                        set state='processing',delivery_attempts=o.delivery_attempts+1,
                            lease_token=$2,
                            lease_expires_at=clock_timestamp()+$3::integer*interval '1 second',
                            updated_at=clock_timestamp()
                       from candidates c where o.id=c.id
                     returning o.*""",
                limit,
                lease_token,
                lease_seconds,
            )
        return [
            DispatchOutboxClaim(
                dispatch_id=UUID(str(row["id"])),
                job_id=UUID(str(row["job_id"])),
                attempt_id=UUID(str(row["attempt_id"])),
                delivery_attempts=int(row["delivery_attempts"]),
                lease_token=lease_token,
            )
            for row in rows
        ]

    async def finalize_dispatch(self, claim: DispatchOutboxClaim) -> bool:
        async with self.pool.acquire() as connection:
            updated = await connection.fetchval(
                """update job_example_dispatch_outbox
                      set state='done',completed_at=clock_timestamp(),last_error=null,
                          lease_token=null,lease_expires_at=null,
                          updated_at=clock_timestamp()
                    where id=$1 and state='processing' and lease_token=$2
                      and lease_expires_at > clock_timestamp()
                    returning id""",
                claim.dispatch_id,
                claim.lease_token,
            )
        return updated is not None

    async def release_dispatch_claim(
        self, claim: DispatchOutboxClaim, *, error: str, retry_seconds: int
    ) -> bool:
        error = _bounded_key(error, field="dispatch error", maximum=128)
        retry_seconds = _bounded_integer(
            retry_seconds, field="retry seconds", lower=0, upper=_MAX_RETRY_SECONDS
        )
        async with self.pool.acquire() as connection:
            updated = await connection.fetchval(
                """update job_example_dispatch_outbox
                      set state='pending',available_at=clock_timestamp()
                              +$3::integer*interval '1 second',
                          lease_token=null,lease_expires_at=null,last_error=$4,
                          updated_at=clock_timestamp()
                    where id=$1 and state='processing' and lease_token=$2
                    returning id""",
                claim.dispatch_id,
                claim.lease_token,
                retry_seconds,
                error,
            )
        return updated is not None

    async def consume_dispatch(
        self, message: DispatchMessage, *, execution_lease_seconds: int = 60
    ) -> tuple[ConsumeOutcome, ExecutionClaim | None]:
        execution_lease_seconds = _bounded_integer(
            execution_lease_seconds,
            field="execution lease seconds",
            lower=1,
            upper=_MAX_LEASE_SECONDS,
        )
        execution_token = uuid4()
        async with self.pool.acquire() as connection, connection.transaction():
            dispatch = await connection.fetchrow(
                """select d.id,d.job_id,d.attempt_id,j.payload
                     from job_example_dispatch_outbox d
                     join job_example_jobs j on j.id=d.job_id
                    where d.id=$1 and d.state in ('processing','done')
                    for update of d""",
                message.dispatch_id,
            )
            if dispatch is None:
                return "stale", None
            inserted = await connection.fetchval(
                """insert into job_example_queue_inbox(dispatch_id,attempt_id,outcome)
                     values($1,$2,'consumed')
                     on conflict(dispatch_id) do nothing returning dispatch_id""",
                message.dispatch_id,
                dispatch["attempt_id"],
            )
            if inserted is None:
                return "duplicate", None
            attempt = await connection.fetchrow(
                """update job_example_attempts
                      set state='running',execution_token=$2,
                          execution_lease_expires_at=clock_timestamp()
                              +$3::integer*interval '1 second',
                          execution_generation=execution_generation+1,
                          updated_at=clock_timestamp()
                    where id=$1 and state='ready'
                    returning execution_generation""",
                dispatch["attempt_id"],
                execution_token,
                execution_lease_seconds,
            )
            if attempt is None:
                await connection.execute(
                    """update job_example_queue_inbox set outcome='stale'
                        where dispatch_id=$1""",
                    message.dispatch_id,
                )
                return "stale", None
            job = await connection.fetchval(
                """update job_example_jobs set state='running',updated_at=clock_timestamp()
                    where id=$1 and state='ready' returning id""",
                dispatch["job_id"],
            )
            if job is None:
                raise WorkflowInvariantError("dispatch found a non-ready job")
            payload = dispatch["payload"]
            if not isinstance(payload, dict):
                payload = json.loads(str(payload))
            return (
                "started",
                ExecutionClaim(
                    job_id=UUID(str(dispatch["job_id"])),
                    attempt_id=UUID(str(dispatch["attempt_id"])),
                    execution_token=execution_token,
                    generation=int(attempt["execution_generation"]),
                    payload=payload,
                ),
            )

    async def reclaim_execution(
        self, attempt_id: UUID, *, lease_seconds: int = 60
    ) -> ExecutionClaim | None:
        lease_seconds = _bounded_integer(
            lease_seconds, field="execution lease seconds", lower=1, upper=_MAX_LEASE_SECONDS
        )
        execution_token = uuid4()
        async with self.pool.acquire() as connection, connection.transaction():
            row = await connection.fetchrow(
                """update job_example_attempts a
                      set execution_token=$2,
                          execution_lease_expires_at=clock_timestamp()
                              +$3::integer*interval '1 second',
                          execution_generation=execution_generation+1,
                          updated_at=clock_timestamp()
                     from job_example_jobs j
                    where a.id=$1 and a.job_id=j.id and a.state='running'
                      and j.state='running'
                      and a.execution_lease_expires_at <= clock_timestamp()
                    returning a.job_id,a.id,a.execution_generation,j.payload""",
                attempt_id,
                execution_token,
                lease_seconds,
            )
        if row is None:
            return None
        payload = row["payload"]
        if not isinstance(payload, dict):
            payload = json.loads(str(payload))
        return ExecutionClaim(
            job_id=UUID(str(row["job_id"])),
            attempt_id=UUID(str(row["id"])),
            execution_token=execution_token,
            generation=int(row["execution_generation"]),
            payload=payload,
        )

    async def complete_execution(self, execution: ExecutionClaim) -> bool:
        async with self.pool.acquire() as connection, connection.transaction():
            attempt = await connection.fetchval(
                """update job_example_attempts
                      set state='succeeded',execution_token=null,
                          execution_lease_expires_at=null,updated_at=clock_timestamp()
                    where id=$1 and job_id=$2 and state='running'
                      and execution_token=$3
                      and execution_lease_expires_at > clock_timestamp()
                    returning id""",
                execution.attempt_id,
                execution.job_id,
                execution.execution_token,
            )
            if attempt is None:
                return False
            job = await connection.fetchval(
                """update job_example_jobs set state='succeeded',updated_at=clock_timestamp()
                    where id=$1 and state='running' returning id""",
                execution.job_id,
            )
            if job is None:
                raise WorkflowInvariantError("successful attempt found a non-running job")
        return True

    async def renew_execution(self, execution: ExecutionClaim, *, lease_seconds: int = 60) -> bool:
        """Heartbeat only the current, still-live execution fencing token."""

        lease_seconds = _bounded_integer(
            lease_seconds,
            field="execution lease seconds",
            lower=1,
            upper=_MAX_LEASE_SECONDS,
        )
        async with self.pool.acquire() as connection:
            updated = await connection.fetchval(
                """update job_example_attempts a
                      set execution_lease_expires_at=clock_timestamp()
                              +$4::integer*interval '1 second',
                          updated_at=clock_timestamp()
                     from job_example_jobs j
                    where a.id=$1 and a.job_id=$2 and a.job_id=j.id
                      and a.state='running' and j.state='running'
                      and a.execution_token=$3
                      and a.execution_lease_expires_at > clock_timestamp()
                    returning a.id""",
                execution.attempt_id,
                execution.job_id,
                execution.execution_token,
                lease_seconds,
            )
        return updated is not None

    async def fail_execution(self, execution: ExecutionClaim, *, reason: str) -> bool:
        reason = _bounded_key(reason, field="terminal reason", maximum=128)
        refund_id = uuid4()
        async with self.pool.acquire() as connection, connection.transaction():
            attempt = await connection.fetchval(
                """update job_example_attempts
                      set state='failed_pending_refund',execution_token=null,
                          execution_lease_expires_at=null,terminal_reason=$4,
                          updated_at=clock_timestamp()
                    where id=$1 and job_id=$2 and state='running'
                      and execution_token=$3
                      and execution_lease_expires_at > clock_timestamp()
                    returning id""",
                execution.attempt_id,
                execution.job_id,
                execution.execution_token,
                reason,
            )
            if attempt is None:
                return False
            job = await connection.fetchval(
                """update job_example_jobs
                      set state='refund_pending',updated_at=clock_timestamp()
                    where id=$1 and state='running' returning id""",
                execution.job_id,
            )
            if job is None:
                raise WorkflowInvariantError("failed attempt found a non-running job")
            refund = await connection.fetchval(
                """insert into job_example_billing_outbox
                       (id,job_id,attempt_id,operation,owner_external_ref,
                        amount_decimal,amount_atoms,credit_key)
                     select $1,o.job_id,o.attempt_id,'refund',o.owner_external_ref,
                            o.amount_decimal,o.amount_atoms,o.credit_key
                       from job_example_billing_outbox o
                      where o.attempt_id=$2 and o.operation='charge' and o.state='done'
                     on conflict(operation,credit_key) do nothing returning id""",
                refund_id,
                execution.attempt_id,
            )
            if refund is None:
                raise WorkflowInvariantError("terminal failure has no completed charge to refund")
        return True


class BillingOutboxWorker:
    """Calls billing only after the host claim transaction has committed."""

    def __init__(
        self,
        store: JobWorkflowStore,
        billing: BillingClient | EntitlementService,
        *,
        lease_seconds: int = 30,
        retry_seconds: int = 1,
    ) -> None:
        self.store = store
        self.billing = billing
        self.lease_seconds = _bounded_integer(
            lease_seconds, field="lease seconds", lower=1, upper=_MAX_LEASE_SECONDS
        )
        self.retry_seconds = _bounded_integer(
            retry_seconds, field="retry seconds", lower=0, upper=_MAX_RETRY_SECONDS
        )

    async def run_once(self, *, limit: int = 10) -> list[WorkerOutcome]:
        claims = await self.store.claim_billing(limit=limit, lease_seconds=self.lease_seconds)
        return [await self.process_claim(claim) for claim in claims]

    async def process_claim(self, claim: BillingOutboxClaim) -> WorkerOutcome:
        try:
            try:
                normalized = CreditAmount.parse(
                    claim.amount_decimal,
                    field="outbox credit amount",
                    allow_zero=False,
                )
            except ValueError as exc:
                raise InvalidCreditRequestError("outbox credit amount is invalid") from exc
            if normalized.atoms != claim.amount_atoms:
                raise InvalidCreditRequestError("outbox decimal/atom amount drifted")
            if claim.operation == "charge":
                result = await self.billing.charge(
                    claim.owner_external_ref,
                    claim.amount_decimal,
                    claim.credit_key,
                )
            else:
                result = await self.billing.refund(
                    claim.owner_external_ref,
                    claim.credit_key,
                )
        except (CreditsUnavailableError, InsufficientCreditsError) as exc:
            if claim.operation == "charge":
                finalized = await self.store.finalize_charge_rejected(
                    claim, reason=type(exc).__name__
                )
                return "rejected" if finalized else "lease_lost"
            finalized = await self.store.finalize_billing_permanent_failure(
                claim, error=type(exc).__name__
            )
            return "manual_review" if finalized else "lease_lost"
        except (
            BillingOwnerNotFoundError,
            CreditIdempotencyConflictError,
            CreditOperationNotFoundError,
            InvalidCreditRequestError,
            InvalidOwnerReferenceError,
        ) as exc:
            if claim.operation == "charge":
                finalized = await self.store.finalize_charge_rejected(
                    claim, reason=type(exc).__name__
                )
                return "rejected" if finalized else "lease_lost"
            finalized = await self.store.finalize_billing_permanent_failure(
                claim, error=type(exc).__name__
            )
            return "manual_review" if finalized else "lease_lost"
        except Exception as exc:
            released = await self.store.release_billing_claim(
                claim,
                error=type(exc).__name__,
                retry_seconds=self.retry_seconds,
            )
            return "retry" if released else "lease_lost"

        if claim.operation == "charge" and result.outcome in {"charged", "replayed"}:
            charge_outcome = cast(Literal["charged", "replayed"], result.outcome)
            finalized = await self.store.finalize_charge_success(claim, charge_outcome)
            return "completed" if finalized else "lease_lost"
        if claim.operation == "refund" and result.outcome in {
            "refunded",
            "replayed",
            "epoch_expired",
        }:
            refund_outcome = cast(Literal["refunded", "replayed", "epoch_expired"], result.outcome)
            finalized = await self.store.finalize_refund_success(claim, refund_outcome)
            return "completed" if finalized else "lease_lost"
        finalized = await self.store.finalize_billing_permanent_failure(
            claim, error="UnexpectedCreditOutcome"
        )
        return "manual_review" if finalized else "lease_lost"


class DispatchOutboxWorker:
    """Publishes at least once; queue consumers deduplicate the immutable dispatch ID."""

    def __init__(
        self,
        store: JobWorkflowStore,
        publisher: QueuePublisher,
        *,
        lease_seconds: int = 30,
        retry_seconds: int = 1,
    ) -> None:
        self.store = store
        self.publisher = publisher
        self.lease_seconds = _bounded_integer(
            lease_seconds, field="lease seconds", lower=1, upper=_MAX_LEASE_SECONDS
        )
        self.retry_seconds = _bounded_integer(
            retry_seconds, field="retry seconds", lower=0, upper=_MAX_RETRY_SECONDS
        )

    async def run_once(self, *, limit: int = 10) -> list[DispatchOutcome]:
        claims = await self.store.claim_dispatch(limit=limit, lease_seconds=self.lease_seconds)
        return [await self.process_claim(claim) for claim in claims]

    async def process_claim(self, claim: DispatchOutboxClaim) -> DispatchOutcome:
        try:
            await self.publisher.publish(claim.message)
        except Exception as exc:
            released = await self.store.release_dispatch_claim(
                claim,
                error=type(exc).__name__,
                retry_seconds=self.retry_seconds,
            )
            return "retry" if released else "lease_lost"
        finalized = await self.store.finalize_dispatch(claim)
        return "published" if finalized else "lease_lost"


class QueueConsumer:
    """Business-idempotent consumer and execution-fencing facade."""

    def __init__(self, store: JobWorkflowStore, *, execution_lease_seconds: int = 60) -> None:
        self.store = store
        self.execution_lease_seconds = _bounded_integer(
            execution_lease_seconds,
            field="execution lease seconds",
            lower=1,
            upper=_MAX_LEASE_SECONDS,
        )

    async def consume(
        self, message: DispatchMessage
    ) -> tuple[ConsumeOutcome, ExecutionClaim | None]:
        return await self.store.consume_dispatch(
            message, execution_lease_seconds=self.execution_lease_seconds
        )
