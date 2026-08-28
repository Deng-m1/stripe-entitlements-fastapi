from __future__ import annotations

import hashlib
import uuid
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from datetime import timedelta
from typing import Any, Literal, Protocol, TypeVar

import asyncpg

from .bounds import POSTGRES_BIGINT_MAX
from .credit_amount import CreditAmount
from .processor import EventProcessor
from .types import ProcessResult

_PACK_SCHEMA_VERSION = "1"
_RECONCILABLE_PAYMENT_STATUSES = {
    "pending",
    "paid",
    "partially_refunded",
    "refunded",
    "disputed",
}
_PAYMENT_INTENT_STATUSES = {
    "canceled",
    "processing",
    "requires_action",
    "requires_capture",
    "requires_confirmation",
    "requires_payment_method",
    "succeeded",
}
_CHECKOUT_STATUSES = {"open", "complete", "expired"}
_CHECKOUT_PAYMENT_STATUSES = {"paid", "unpaid", "no_payment_required"}

T = TypeVar("T")


class CreditPackReconciliationGateway(Protocol):
    async def checkout_session_object(self, session_id: str) -> dict[str, Any]: ...

    async def payment_intent_object(self, payment_intent_id: str) -> dict[str, Any]: ...

    async def charge_object(self, charge_id: str) -> dict[str, Any]: ...


class CreditPackRemoteContractError(RuntimeError):
    """A retrieved Stripe object cannot prove the local order contract."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class CreditPackProjectionError(RuntimeError):
    """A remote-verified fact was not accepted by the transactional projector."""


class _LeaseLost(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class CreditPackReconcileClaim:
    order_id: str
    account_id: str
    token: str
    checkout_status: str
    payment_status: str
    session_id: str | None
    payment_intent_id: str | None
    charge_id: str | None
    account_customer_id: str | None
    order_customer_id: str | None
    request_customer_id: str | None
    pack_key: str
    pack_credits: int
    price_amount: int
    currency: str
    expires_days: int
    lookup_key: str
    amount_paid: int | None
    amount_refunded: int


CreditPackReconcileOutcome = Literal[
    "reconciled",
    "idle",
    "failed",
    "lost_lease",
    "unavailable",
]


@dataclass(frozen=True, slots=True)
class CreditPackReconcileResult:
    order_id: str
    outcome: CreditPackReconcileOutcome
    projections: tuple[ProcessResult, ...] = ()
    error_code: str | None = None


@dataclass(frozen=True, slots=True)
class _SessionFact:
    raw: dict[str, Any]
    status: str
    payment_status: str
    payment_intent_id: str | None
    customer_id: str | None
    created: int


@dataclass(frozen=True, slots=True)
class _PaymentIntentFact:
    raw: dict[str, Any]
    status: str
    customer_id: str
    charge_id: str | None
    created: int


@dataclass(frozen=True, slots=True)
class _ChargeFact:
    raw: dict[str, Any]
    customer_id: str
    amount_refunded: int
    disputed: bool
    created: int


def _remote_copy(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {
            str(key): _remote_copy(item)
            for key, item in value.items()
            if not str(key).startswith("_")
        }
    if isinstance(value, list):
        return [_remote_copy(item) for item in value]
    return value


def _stripe_id(value: Any, prefix: str, *, code: str, optional: bool = False) -> str | None:
    candidate = value.get("id") if isinstance(value, Mapping) else value
    if candidate is None and optional:
        return None
    if (
        not isinstance(candidate, str)
        or not candidate.startswith(prefix)
        or candidate != candidate.strip()
        or len(candidate.encode("utf-8")) > 255
        or any(not character.isprintable() for character in candidate)
    ):
        raise CreditPackRemoteContractError(code)
    return candidate


def _integer(value: Any, *, code: str, minimum: int = 0) -> int:
    if type(value) is not int or value < minimum or value > POSTGRES_BIGINT_MAX:
        raise CreditPackRemoteContractError(code)
    return value


def _created(value: Any, *, code: str) -> int:
    return _integer(value, code=code)


def _fact_event_id(kind: str, *identity: object) -> str:
    fingerprint = hashlib.sha256(
        "\x1f".join(str(value) for value in identity).encode("utf-8")
    ).hexdigest()
    return f"reconcile:credit-pack:{kind}:{fingerprint}"


class CreditPackReconciliationService:
    """Rebuilds missed credit-pack facts from Stripe's current remote state.

    A short PostgreSQL transaction leases one order. Stripe calls happen only after
    that transaction has committed. Synthetic facts carry an internal lease guard;
    EventProcessor validates and locks it in the same transaction as Event inbox
    claim and business projection, closing the network-return fencing race.
    """

    def __init__(
        self,
        pool: asyncpg.Pool,
        processor: EventProcessor,
        gateway: CreditPackReconciliationGateway,
        *,
        lease: timedelta = timedelta(minutes=5),
        pending_interval: timedelta = timedelta(minutes=5),
        paid_interval: timedelta = timedelta(hours=6),
    ) -> None:
        for name, value, maximum in (
            ("lease", lease, timedelta(hours=1)),
            ("pending_interval", pending_interval, timedelta(days=1)),
            ("paid_interval", paid_interval, timedelta(days=30)),
        ):
            if value <= timedelta(0) or value > maximum:
                raise ValueError(f"credit-pack reconciliation {name} is outside its safe bound")
        self.pool = pool
        self.processor = processor
        self.gateway = gateway
        self.lease = lease
        self.pending_interval = pending_interval
        self.paid_interval = paid_interval

    @staticmethod
    def _claim(row: Mapping[str, Any]) -> CreditPackReconcileClaim:
        return CreditPackReconcileClaim(
            order_id=str(row["id"]),
            account_id=str(row["account_id"]),
            token=str(row["reconcile_claim_token"]),
            checkout_status=str(row["checkout_status"]),
            payment_status=str(row["payment_status"]),
            session_id=row["stripe_checkout_session_id"],
            payment_intent_id=row["stripe_payment_intent_id"],
            charge_id=row["stripe_charge_id"],
            account_customer_id=row["account_customer_id"],
            order_customer_id=row["stripe_customer_id"],
            request_customer_id=row["request_customer_id"],
            pack_key=str(row["pack_key"]),
            pack_credits=int(row["pack_credits"]),
            price_amount=int(row["price_amount"]),
            currency=str(row["currency"]),
            expires_days=int(row["expires_days"]),
            lookup_key=str(row["price_lookup_key"]),
            amount_paid=(int(row["amount_paid"]) if row["amount_paid"] is not None else None),
            amount_refunded=int(row["amount_refunded"]),
        )

    async def _claim_next(self) -> CreditPackReconcileClaim | None:
        token = uuid.uuid4()
        async with self.pool.acquire() as conn, conn.transaction():
            row = await conn.fetchrow(
                """with candidate as (
                       select o.id
                         from credit_pack_orders o
                        where (
                               o.payment_status in ('pending','paid','partially_refunded')
                               or (
                                 o.payment_status in ('refunded','disputed')
                                 and not exists (
                                   select 1 from credit_funding_lots l where l.order_id=o.id
                                 )
                               )
                              )
                          and (o.reconcile_claim_token is null
                               or o.reconcile_claim_expires_at <= clock_timestamp())
                          and (o.last_reconciled_at is null
                               or o.last_reconciled_at < clock_timestamp() -
                                  case when o.payment_status='pending'
                                       then $1::interval else $2::interval end)
                        order by o.last_reconciled_at nulls first,
                                 case when o.payment_status='pending' then 0 else 1 end,
                                 o.id
                        for update skip locked
                        limit 1
                     ), claimed as (
                       update credit_pack_orders o
                          set reconcile_claim_token=$3,
                              reconcile_claim_expires_at=clock_timestamp()+$4::interval,
                              updated_at=clock_timestamp()
                         from candidate c where o.id=c.id
                       returning o.*
                     )
                     select c.*,a.stripe_customer_id as account_customer_id
                       from claimed c join billing_accounts a on a.id=c.account_id""",
                self.pending_interval,
                self.paid_interval,
                token,
                self.lease,
            )
        return self._claim(row) if row is not None else None

    async def _claim_order(self, order_id: str) -> CreditPackReconcileClaim | None:
        try:
            order_uuid = uuid.UUID(order_id)
        except (ValueError, TypeError, AttributeError):
            return None
        token = uuid.uuid4()
        async with self.pool.acquire() as conn, conn.transaction():
            row = await conn.fetchrow(
                """with claimed as (
                       update credit_pack_orders o
                          set reconcile_claim_token=$2,
                              reconcile_claim_expires_at=clock_timestamp()+$3::interval,
                              updated_at=clock_timestamp()
                        where o.id=$1
                          and o.payment_status in
                              ('pending','paid','partially_refunded','refunded','disputed')
                          and (o.reconcile_claim_token is null
                               or o.reconcile_claim_expires_at <= clock_timestamp())
                       returning o.*
                     )
                     select c.*,a.stripe_customer_id as account_customer_id
                       from claimed c join billing_accounts a on a.id=c.account_id""",
                order_uuid,
                token,
                self.lease,
            )
        return self._claim(row) if row is not None else None

    async def _renew(self, claim: CreditPackReconcileClaim) -> bool:
        async with self.pool.acquire() as conn:
            renewed = await conn.fetchval(
                """update credit_pack_orders
                      set reconcile_claim_expires_at=clock_timestamp()+$3::interval,
                          updated_at=clock_timestamp()
                    where id=$1::uuid and reconcile_claim_token=$2::uuid
                      and reconcile_claim_expires_at > clock_timestamp()
                    returning id""",
                claim.order_id,
                claim.token,
                self.lease,
            )
        return renewed is not None

    async def _remote(self, claim: CreditPackReconcileClaim, call: Callable[[], Awaitable[T]]) -> T:
        if not await self._renew(claim):
            raise _LeaseLost
        result = await call()
        if not await self._renew(claim):
            raise _LeaseLost
        return result

    def _metadata_matches(self, claim: CreditPackReconcileClaim, raw: Mapping[str, Any]) -> bool:
        metadata = raw.get("metadata")
        if not isinstance(metadata, Mapping):
            return False
        expected = {
            "billing_kind": "credit_pack",
            "pack_schema_version": _PACK_SCHEMA_VERSION,
            "product_line": self.processor.product_line,
            "credit_pack_order_id": claim.order_id,
            "account_id": claim.account_id,
            "pack_key": claim.pack_key,
            "pack_credits": str(CreditAmount.from_atoms(claim.pack_credits)),
            "price_amount": str(claim.price_amount),
            "currency": claim.currency,
            "expires_days": str(claim.expires_days),
            "lookup_key": claim.lookup_key,
        }
        return all(metadata.get(key) == value for key, value in expected.items())

    def _mode_matches(self, raw: Mapping[str, Any]) -> bool:
        return raw.get("livemode") is self.processor.expected_livemode

    def _validate_session(
        self, claim: CreditPackReconcileClaim, raw_value: Mapping[str, Any]
    ) -> _SessionFact:
        raw = _remote_copy(raw_value)
        if not isinstance(raw, dict):
            raise CreditPackRemoteContractError("checkout_shape_invalid")
        session_id = _stripe_id(raw.get("id"), "cs_", code="checkout_identity_invalid")
        status = raw.get("status")
        payment_status = raw.get("payment_status")
        if (
            session_id != claim.session_id
            or raw.get("object") != "checkout.session"
            or raw.get("mode") != "payment"
            or status not in _CHECKOUT_STATUSES
            or payment_status not in _CHECKOUT_PAYMENT_STATUSES
            or not self._mode_matches(raw)
            or raw.get("client_reference_id") != claim.account_id
            or not self._metadata_matches(claim, raw)
            or _integer(raw.get("amount_total"), code="checkout_amount_invalid")
            != claim.price_amount
            or raw.get("currency") != claim.currency
        ):
            raise CreditPackRemoteContractError("checkout_contract_mismatch")
        payment_intent_id = _stripe_id(
            raw.get("payment_intent"),
            "pi_",
            code="checkout_payment_identity_invalid",
            optional=True,
        )
        customer_id = _stripe_id(
            raw.get("customer"),
            "cus_",
            code="checkout_customer_identity_invalid",
            optional=True,
        )
        if claim.payment_intent_id not in {None, payment_intent_id}:
            raise CreditPackRemoteContractError("checkout_payment_identity_conflict")
        if any(
            expected not in {None, customer_id}
            for expected in (
                claim.request_customer_id,
                claim.order_customer_id,
                claim.account_customer_id,
            )
        ):
            raise CreditPackRemoteContractError("checkout_customer_identity_conflict")
        if status == "complete" and (payment_intent_id is None or customer_id is None):
            raise CreditPackRemoteContractError("checkout_completion_incomplete")
        if status == "complete" and payment_status == "no_payment_required":
            raise CreditPackRemoteContractError("checkout_payment_contract_mismatch")
        return _SessionFact(
            raw,
            str(status),
            str(payment_status),
            payment_intent_id,
            customer_id,
            _created(raw.get("created"), code="checkout_created_invalid"),
        )

    def _validate_payment_intent(
        self,
        claim: CreditPackReconcileClaim,
        raw_value: Mapping[str, Any],
        *,
        expected_id: str,
        session_customer_id: str | None,
    ) -> _PaymentIntentFact:
        raw = _remote_copy(raw_value)
        if not isinstance(raw, dict):
            raise CreditPackRemoteContractError("payment_intent_shape_invalid")
        payment_intent_id = _stripe_id(raw.get("id"), "pi_", code="payment_intent_identity_invalid")
        status = raw.get("status")
        customer_id = _stripe_id(
            raw.get("customer"), "cus_", code="payment_intent_customer_invalid"
        )
        amount = _integer(raw.get("amount"), code="payment_intent_amount_invalid")
        amount_received = _integer(
            raw.get("amount_received"), code="payment_intent_received_invalid"
        )
        if (
            payment_intent_id != expected_id
            or raw.get("object") != "payment_intent"
            or status not in _PAYMENT_INTENT_STATUSES
            or not self._mode_matches(raw)
            or not self._metadata_matches(claim, raw)
            or amount != claim.price_amount
            or amount_received > amount
            or raw.get("currency") != claim.currency
        ):
            raise CreditPackRemoteContractError("payment_intent_contract_mismatch")
        if any(
            expected not in {None, customer_id}
            for expected in (
                claim.request_customer_id,
                claim.order_customer_id,
                claim.account_customer_id,
                session_customer_id,
            )
        ):
            raise CreditPackRemoteContractError("payment_intent_customer_conflict")
        if status == "succeeded" and amount_received != amount:
            raise CreditPackRemoteContractError("payment_intent_settlement_mismatch")
        if claim.amount_paid not in {None, amount_received}:
            raise CreditPackRemoteContractError("payment_intent_settlement_regressed")
        if claim.payment_status != "pending" and status != "succeeded":
            raise CreditPackRemoteContractError("payment_intent_status_regressed")
        charge_id = _stripe_id(
            raw.get("latest_charge"),
            "ch_",
            code="payment_intent_charge_invalid",
            optional=True,
        )
        if claim.charge_id not in {None, charge_id}:
            raise CreditPackRemoteContractError("payment_intent_charge_conflict")
        if status == "succeeded" and charge_id is None:
            raise CreditPackRemoteContractError("payment_intent_charge_missing")
        return _PaymentIntentFact(
            raw,
            str(status),
            str(customer_id),
            charge_id,
            _created(raw.get("created"), code="payment_intent_created_invalid"),
        )

    def _validate_charge(
        self,
        claim: CreditPackReconcileClaim,
        raw_value: Mapping[str, Any],
        *,
        expected_id: str,
        payment_intent_id: str,
        customer_id: str,
    ) -> _ChargeFact:
        raw = _remote_copy(raw_value)
        if not isinstance(raw, dict):
            raise CreditPackRemoteContractError("charge_shape_invalid")
        charge_id = _stripe_id(raw.get("id"), "ch_", code="charge_identity_invalid")
        remote_payment = _stripe_id(
            raw.get("payment_intent"), "pi_", code="charge_payment_identity_invalid"
        )
        remote_customer = _stripe_id(
            raw.get("customer"), "cus_", code="charge_customer_identity_invalid"
        )
        amount = _integer(raw.get("amount"), code="charge_amount_invalid")
        amount_refunded = _integer(raw.get("amount_refunded"), code="charge_refund_amount_invalid")
        disputed = raw.get("disputed")
        refunded = raw.get("refunded")
        if (
            charge_id != expected_id
            or remote_payment != payment_intent_id
            or remote_customer != customer_id
            or raw.get("object") != "charge"
            or raw.get("paid") is not True
            or not isinstance(disputed, bool)
            or not isinstance(refunded, bool)
            or not self._mode_matches(raw)
            or amount != claim.price_amount
            or amount_refunded > amount
            or (not disputed and amount_refunded < claim.amount_refunded)
            or refunded is not (amount_refunded == amount)
            or raw.get("currency") != claim.currency
        ):
            raise CreditPackRemoteContractError("charge_contract_mismatch")
        return _ChargeFact(
            raw,
            str(remote_customer),
            amount_refunded,
            disputed,
            _created(raw.get("created"), code="charge_created_invalid"),
        )

    def _event(
        self,
        claim: CreditPackReconcileClaim,
        *,
        event_id: str,
        event_type: str,
        created: int,
        obj: Mapping[str, Any],
    ) -> dict[str, Any]:
        return {
            "id": event_id,
            "object": "event",
            "type": event_type,
            "created": created,
            "livemode": self.processor.expected_livemode,
            "_remote_verified": True,
            "_credit_pack_reconcile_claim": {
                "order_id": claim.order_id,
                "account_id": claim.account_id,
                "token": claim.token,
            },
            "data": {"object": dict(obj)},
        }

    async def _project(
        self,
        claim: CreditPackReconcileClaim,
        event: dict[str, Any],
    ) -> ProcessResult:
        if not await self._renew(claim):
            raise _LeaseLost
        result = await self.processor.process(event)
        if result.outcome == "ignored" and result.reason == "credit-pack reconciliation lease lost":
            raise _LeaseLost
        if result.outcome in {"handled", "replayed"}:
            return result
        if result.outcome == "duplicate":
            async with self.pool.acquire() as conn:
                prior = await conn.fetchval(
                    "select outcome from stripe_webhook_events where id=$1", event["id"]
                )
            if prior in {"handled", "replayed"}:
                return result
        raise CreditPackProjectionError("remote-verified credit-pack fact was not committed")

    async def _finish(self, claim: CreditPackReconcileClaim, error_code: str | None) -> bool:
        async with self.pool.acquire() as conn:
            finished = await conn.fetchval(
                """update credit_pack_orders
                      set reconcile_claim_token=null,reconcile_claim_expires_at=null,
                          last_reconciled_at=clock_timestamp(),last_reconcile_error=$3,
                          updated_at=clock_timestamp()
                    where id=$1::uuid and reconcile_claim_token=$2::uuid
                      and reconcile_claim_expires_at > clock_timestamp()
                    returning id""",
                claim.order_id,
                claim.token,
                error_code,
            )
        return finished is not None

    @staticmethod
    def _error_code(exc: Exception) -> str:
        if isinstance(exc, CreditPackRemoteContractError):
            return exc.code
        return type(exc).__name__[:255]

    async def _reconcile_claim(self, claim: CreditPackReconcileClaim) -> CreditPackReconcileResult:
        projections: list[ProcessResult] = []
        try:
            session: _SessionFact | None = None
            payment_intent_id = claim.payment_intent_id
            session_customer_id: str | None = None
            session_id = claim.session_id
            if session_id is not None:
                remote_session = await self._remote(
                    claim,
                    lambda: self.gateway.checkout_session_object(session_id),
                )
                session = self._validate_session(claim, remote_session)
                payment_intent_id = payment_intent_id or session.payment_intent_id
                session_customer_id = session.customer_id

            payment_intent: _PaymentIntentFact | None = None
            charge: _ChargeFact | None = None
            charge_id = claim.charge_id
            if payment_intent_id is not None:
                remote_payment_intent = await self._remote(
                    claim,
                    lambda: self.gateway.payment_intent_object(payment_intent_id),
                )
                payment_intent = self._validate_payment_intent(
                    claim,
                    remote_payment_intent,
                    expected_id=payment_intent_id,
                    session_customer_id=session_customer_id,
                )
                if (
                    session is not None
                    and session.payment_status == "paid"
                    and payment_intent.status != "succeeded"
                ):
                    raise CreditPackRemoteContractError("checkout_payment_status_mismatch")
                charge_id = charge_id or payment_intent.charge_id
                if charge_id is not None:
                    remote_charge = await self._remote(
                        claim,
                        lambda: self.gateway.charge_object(charge_id),
                    )
                    charge = self._validate_charge(
                        claim,
                        remote_charge,
                        expected_id=charge_id,
                        payment_intent_id=payment_intent_id,
                        customer_id=payment_intent.customer_id,
                    )

            if session is not None and session.status in {"complete", "expired"}:
                event_type = (
                    "checkout.session.completed"
                    if session.status == "complete"
                    else "checkout.session.expired"
                )
                projections.append(
                    await self._project(
                        claim,
                        self._event(
                            claim,
                            event_id=_fact_event_id(
                                "checkout",
                                claim.order_id,
                                claim.session_id,
                                session.status,
                                session.payment_intent_id,
                            ),
                            event_type=event_type,
                            created=session.created,
                            obj=session.raw,
                        ),
                    )
                )

            if payment_intent is not None and payment_intent.status == "succeeded":
                projections.append(
                    await self._project(
                        claim,
                        self._event(
                            claim,
                            event_id=_fact_event_id(
                                "payment",
                                claim.order_id,
                                payment_intent_id,
                                payment_intent.charge_id,
                            ),
                            event_type="payment_intent.succeeded",
                            created=charge.created
                            if charge is not None
                            else payment_intent.created,
                            obj=payment_intent.raw,
                        ),
                    )
                )

            if charge is not None and (charge.disputed or charge.amount_refunded > 0):
                assert payment_intent is not None
                if charge.disputed:
                    event_type = "charge.dispute.created"
                    digest = _fact_event_id(
                        "dispute", claim.order_id, payment_intent_id, charge_id
                    ).rsplit(":", 1)[-1]
                    event_object = {
                        "id": f"dp_reconcile_{digest[:32]}",
                        "object": "dispute",
                        "charge": charge_id,
                        "amount": claim.price_amount,
                        "currency": claim.currency,
                        "_resolved_charge": charge.raw,
                        "_resolved_payment_intent": payment_intent.raw,
                    }
                    event_id = _fact_event_id(
                        "dispute", claim.order_id, payment_intent_id, charge_id
                    )
                else:
                    event_type = "charge.refunded"
                    event_object = {
                        **charge.raw,
                        "_resolved_payment_intent": payment_intent.raw,
                    }
                    event_id = _fact_event_id(
                        "refund",
                        claim.order_id,
                        payment_intent_id,
                        charge_id,
                        charge.amount_refunded,
                    )
                projections.append(
                    await self._project(
                        claim,
                        self._event(
                            claim,
                            event_id=event_id,
                            event_type=event_type,
                            created=charge.created,
                            obj=event_object,
                        ),
                    )
                )

            idle_code = (
                "checkout_replay_required"
                if not projections
                and claim.checkout_status == "reserved"
                and claim.session_id is None
                and claim.payment_intent_id is None
                and claim.charge_id is None
                else None
            )
            if not await self._finish(claim, idle_code):
                raise _LeaseLost
            return CreditPackReconcileResult(
                claim.order_id,
                "reconciled" if projections else "idle",
                tuple(projections),
                idle_code,
            )
        except _LeaseLost:
            return CreditPackReconcileResult(
                claim.order_id,
                "lost_lease",
                tuple(projections),
                "lease_lost",
            )
        except Exception as exc:
            error_code = self._error_code(exc)
            if not await self._finish(claim, error_code):
                return CreditPackReconcileResult(
                    claim.order_id,
                    "lost_lease",
                    tuple(projections),
                    "lease_lost",
                )
            return CreditPackReconcileResult(
                claim.order_id,
                "failed",
                tuple(projections),
                error_code,
            )

    async def reconcile_due(self, *, limit: int = 100) -> list[CreditPackReconcileResult]:
        if limit <= 0 or limit > 10_000:
            raise ValueError("credit-pack reconciliation limit must be between 1 and 10000")
        results: list[CreditPackReconcileResult] = []
        for _ in range(limit):
            claim = await self._claim_next()
            if claim is None:
                break
            results.append(await self._reconcile_claim(claim))
        return results

    async def reconcile_order(self, order_id: str) -> CreditPackReconcileResult:
        claim = await self._claim_order(order_id)
        if claim is None:
            return CreditPackReconcileResult(str(order_id), "unavailable")
        return await self._reconcile_claim(claim)


__all__ = [
    "CreditPackReconcileClaim",
    "CreditPackReconcileResult",
    "CreditPackReconciliationGateway",
    "CreditPackReconciliationService",
    "CreditPackRemoteContractError",
]
