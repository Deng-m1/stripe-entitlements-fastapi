from __future__ import annotations

import re
from collections.abc import Collection, Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Literal, cast

import asyncpg

from .bounds import JSON_SAFE_INTEGER_MAX
from .catalog import PlanCatalog
from .credit_amount import CREDIT_SCALE, CreditAmount
from .credits import (
    CreditDebitOwnerMismatchError,
    CreditResult,
    CreditService,
    CreditsUnavailableError,
    InsufficientCreditsError,
)
from .owner_reference import (
    InvalidOwnerReferenceError,
    validate_owner_external_ref,
)
from .subscription_state import (
    spendable_subscription_atoms,
    subscription_credits_are_spendable,
)

_ENTITLEMENT_KEY = re.compile(r"^[a-z][a-z0-9_]{0,63}$")

EntitlementReason = Literal[
    "allowed",
    "owner_not_found",
    "entitlement_not_enforceable",
    "feature_not_available",
    "limit_not_available",
    "limit_exceeded",
]
PlanInterval = Literal["month", "year"]
SubscriptionStatus = Literal["none", "active", "past_due", "canceled"]


class InvalidCreditRequestError(ValueError):
    pass


class BillingOwnerNotFoundError(LookupError):
    pass


class CreditOperationNotFoundError(LookupError):
    pass


class CreditIdempotencyConflictError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class LimitDecision:
    requested: int
    maximum: int | None
    allowed: bool


@dataclass(frozen=True, slots=True)
class EntitlementCheck:
    allowed: bool
    reason: EntitlementReason
    entitlements_enforceable: bool
    plan_key: str
    plan_interval: PlanInterval | None
    subscription_status: SubscriptionStatus
    credits_spendable: bool
    credit_balance: CreditAmount
    # Earliest expiry among funding that is currently spendable. This may be a
    # subscription window or a one-time credit-pack lot.
    credit_expires_at: datetime | None
    features: dict[str, bool]
    limits: dict[str, LimitDecision]

    @property
    def credit_scale(self) -> int:
        return CREDIT_SCALE


def _validate_operation_key(value: str) -> str:
    if (
        type(value) is not str
        or not value
        or value != value.strip()
        or len(value.encode("utf-8")) > 200
        or any(not character.isprintable() for character in value)
    ):
        raise InvalidCreditRequestError("idempotency key is invalid")
    return value


def _validate_requirements(
    required_features: Collection[str], required_limits: Mapping[str, int]
) -> tuple[tuple[str, ...], dict[str, int]]:
    features = tuple(required_features)
    if (
        len(features) > 64
        or len(features) != len(set(features))
        or any(
            type(feature) is not str or _ENTITLEMENT_KEY.fullmatch(feature) is None
            for feature in features
        )
    ):
        raise ValueError("required_features contains an invalid or duplicate key")
    limits = dict(required_limits)
    if len(limits) > 64 or any(
        type(key) is not str
        or _ENTITLEMENT_KEY.fullmatch(key) is None
        or type(value) is not int
        or value < 0
        or value > JSON_SAFE_INTEGER_MAX
        for key, value in limits.items()
    ):
        raise ValueError("required_limits contains an invalid key or value")
    return features, limits


class EntitlementService:
    """Server-side entitlement decisions and owner-bound credit operations."""

    def __init__(self, pool: asyncpg.Pool, catalog: PlanCatalog) -> None:
        self.pool = pool
        self.catalog = catalog
        self.credits = CreditService(pool)

    async def check(
        self,
        owner_external_ref: str,
        *,
        required_features: Collection[str] = (),
        required_limits: Mapping[str, int] | None = None,
    ) -> EntitlementCheck:
        owner_external_ref = validate_owner_external_ref(owner_external_ref)
        features, limits = _validate_requirements(required_features, required_limits or {})
        async with self.pool.acquire() as conn:
            account = await conn.fetchrow(
                """with observed as materialized (
                       select clock_timestamp() as database_now
                     )
                   select a.id,a.plan_key,a.plan_interval,a.subscription_status,
                          a.credits_balance,a.credit_expires_at,a.entitlement_revoked,
                          observed.database_now,
                          coalesce(p.pack_balance,0) as pack_balance,
                          p.next_pack_expiry
                     from billing_accounts a
                     cross join observed
                     left join lateral (
                         select sum(l.remaining_credits) as pack_balance,
                                min(l.expires_at) as next_pack_expiry
                           from credit_funding_lots l
                          where l.account_id=a.id
                            and l.status='active'
                            and l.remaining_credits > 0
                            and l.expires_at > observed.database_now
                     ) p on true
                    where a.external_ref=$1""",
                owner_external_ref,
            )
        if account is None:
            return EntitlementCheck(
                allowed=False,
                reason="owner_not_found",
                entitlements_enforceable=False,
                plan_key="free",
                plan_interval=None,
                subscription_status="none",
                credits_spendable=False,
                credit_balance=CreditAmount.from_atoms(0),
                credit_expires_at=None,
                features={feature: False for feature in features},
                limits={
                    key: LimitDecision(requested=value, maximum=None, allowed=False)
                    for key, value in limits.items()
                },
            )

        plan_key = str(account["plan_key"])
        plan = self.catalog.plans.get(plan_key)
        database_now = account["database_now"]
        expires_at = account["credit_expires_at"]
        subscription_spendable = subscription_credits_are_spendable(account, as_of=database_now)
        enforceable = bool(plan is not None and subscription_spendable)
        subscription_atoms = spendable_subscription_atoms(account, as_of=database_now)
        pack_atoms = int(account["pack_balance"])
        spendable_atoms = subscription_atoms + pack_atoms
        funding_expiries = []
        if subscription_atoms > 0 and isinstance(expires_at, datetime):
            funding_expiries.append(expires_at)
        next_pack_expiry = account["next_pack_expiry"]
        if pack_atoms > 0 and isinstance(next_pack_expiry, datetime):
            funding_expiries.append(next_pack_expiry)
        next_funding_expiry = min(funding_expiries) if funding_expiries else None
        feature_decisions = {
            feature: bool(enforceable and plan is not None and feature in plan.features)
            for feature in features
        }
        limit_decisions: dict[str, LimitDecision] = {}
        for key, requested in limits.items():
            maximum = plan.limits.get(key) if plan is not None else None
            limit_decisions[key] = LimitDecision(
                requested=requested,
                maximum=maximum,
                allowed=bool(enforceable and maximum is not None and requested <= maximum),
            )

        reason: EntitlementReason = "allowed"
        allowed = enforceable
        if not enforceable:
            reason = "entitlement_not_enforceable"
        elif not all(feature_decisions.values()):
            reason = "feature_not_available"
            allowed = False
        elif any(decision.maximum is None for decision in limit_decisions.values()):
            reason = "limit_not_available"
            allowed = False
        elif not all(decision.allowed for decision in limit_decisions.values()):
            reason = "limit_exceeded"
            allowed = False

        return EntitlementCheck(
            allowed=allowed,
            reason=reason,
            entitlements_enforceable=enforceable,
            plan_key=plan_key,
            plan_interval=cast(PlanInterval | None, account["plan_interval"]),
            subscription_status=cast(SubscriptionStatus, account["subscription_status"]),
            credits_spendable=spendable_atoms > 0,
            credit_balance=CreditAmount.from_atoms(spendable_atoms),
            credit_expires_at=next_funding_expiry,
            features=feature_decisions,
            limits=limit_decisions,
        )

    async def charge(
        self,
        owner_external_ref: str,
        amount: str,
        idempotency_key: str,
    ) -> CreditResult:
        owner_external_ref = validate_owner_external_ref(owner_external_ref)
        idempotency_key = _validate_operation_key(idempotency_key)
        if type(amount) is not str:
            raise InvalidCreditRequestError("credit amount must be an exact decimal string")
        try:
            normalized = CreditAmount.parse(amount, field="credit amount", allow_zero=False)
        except ValueError as exc:
            raise InvalidCreditRequestError("credit amount is invalid") from exc
        async with self.pool.acquire() as conn:
            account_id = await conn.fetchval(
                "select id from billing_accounts where external_ref=$1",
                owner_external_ref,
            )
        if account_id is None:
            raise BillingOwnerNotFoundError("billing owner not found")
        try:
            return await self.credits.charge(str(account_id), normalized, idempotency_key)
        except KeyError as exc:
            raise BillingOwnerNotFoundError("billing owner not found") from exc
        except ValueError as exc:
            raise CreditIdempotencyConflictError("idempotency key conflict") from exc

    async def refund(self, owner_external_ref: str, idempotency_key: str) -> CreditResult:
        owner_external_ref = validate_owner_external_ref(owner_external_ref)
        idempotency_key = _validate_operation_key(idempotency_key)
        async with self.pool.acquire() as conn:
            account_id = await conn.fetchval(
                "select id from billing_accounts where external_ref=$1",
                owner_external_ref,
            )
        if account_id is None:
            raise CreditOperationNotFoundError("credit operation not found")
        try:
            return await self.credits.refund(
                idempotency_key,
                expected_account_id=str(account_id),
            )
        except (CreditDebitOwnerMismatchError, KeyError) as exc:
            raise CreditOperationNotFoundError("credit operation not found") from exc


__all__ = [
    "BillingOwnerNotFoundError",
    "CreditIdempotencyConflictError",
    "CreditOperationNotFoundError",
    "CreditsUnavailableError",
    "EntitlementCheck",
    "EntitlementReason",
    "EntitlementService",
    "InsufficientCreditsError",
    "InvalidCreditRequestError",
    "InvalidOwnerReferenceError",
    "LimitDecision",
    "PlanInterval",
    "SubscriptionStatus",
    "validate_owner_external_ref",
]
