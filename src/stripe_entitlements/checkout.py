from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Protocol
from urllib.parse import urlsplit

import asyncpg


class CheckoutBusyError(RuntimeError):
    pass


class CheckoutCreationRejected(RuntimeError):
    """A deterministic pre-creation rejection for which releasing is safe."""


class CheckoutActiveSubscriptionError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class CheckoutReservation:
    account_id: str
    claim_token: str
    plan_key: str
    interval: str
    expires_at: datetime
    request_key: str
    session_id: str | None = None
    session_url: str | None = None


class CheckoutCreator(Protocol):
    async def create_checkout_session(
        self,
        *,
        account_id: str,
        customer_id: str | None,
        lookup_key: str,
        expected_currency: str,
        expected_unit_amount: int,
        expected_interval: str,
        claim_token: str,
        expires_at: datetime,
        customer_email: str | None,
        plan_key: str,
        interval: str,
    ) -> tuple[str, str]: ...


def _validate_visible(value: str, *, field: str, max_bytes: int) -> str:
    if (
        not isinstance(value, str)
        or not value
        or value != value.strip()
        or len(value.encode("utf-8")) > max_bytes
        or any(not character.isprintable() for character in value)
    ):
        raise ValueError(
            f"{field} must contain 1 to {max_bytes} visible UTF-8 bytes without padding"
        )
    return value


def _validate_session_identity(session_id: str, session_url: str) -> None:
    _validate_visible(session_id, field="Checkout Session id", max_bytes=255)
    _validate_visible(session_url, field="Checkout Session URL", max_bytes=2048)
    parsed = urlsplit(session_url)
    if (
        parsed.scheme != "https"
        or not parsed.netloc
        or parsed.username is not None
        or parsed.password is not None
    ):
        raise ValueError("Checkout Session URL must be an origin-safe HTTPS URL")


class CheckoutCoordinator:
    """A PostgreSQL-backed single-flight gate for Checkout Session creation."""

    def __init__(self, pool: asyncpg.Pool) -> None:
        self.pool = pool

    async def reserve(
        self,
        account_id: str,
        plan_key: str,
        interval: str,
        *,
        request_key: str | None = None,
        ttl: timedelta = timedelta(minutes=35),
        now: datetime | None = None,
    ) -> CheckoutReservation:
        if ttl <= timedelta(0):
            raise ValueError("Checkout claim TTL must be positive")
        if now is not None and now.tzinfo is None:
            raise ValueError("Checkout claim time must be timezone-aware")
        plan_key = _validate_visible(plan_key, field="plan_key", max_bytes=64)
        if "_" in plan_key:
            raise ValueError("plan_key cannot contain an underscore")
        if interval not in {"month", "year"}:
            raise ValueError("interval must be month or year")
        token = uuid.uuid4()
        request_key = (
            str(token)
            if request_key is None
            else _validate_visible(request_key, field="request_key", max_bytes=200)
        )
        async with self.pool.acquire() as conn, conn.transaction():
            effective_now = now or await conn.fetchval("select now()")
            assert isinstance(effective_now, datetime)
            expires_at = effective_now + ttl
            account = await conn.fetchrow(
                "select * from billing_accounts where id=$1::uuid for update", account_id
            )
            if account is None:
                raise KeyError("billing account not found")
            if account["stripe_subscription_id"] is not None or account["subscription_status"] in {
                "active",
                "past_due",
            }:
                raise CheckoutActiveSubscriptionError(
                    "an existing subscription must use the plan-change API"
                )
            existing = await conn.fetchrow(
                "select * from checkout_claims where account_id=$1::uuid for update",
                account_id,
            )
            if existing is not None and existing["expires_at"] > effective_now:
                if (
                    existing["client_request_key"] == request_key
                    and existing["plan_key"] == plan_key
                    and existing["plan_interval"] == interval
                ):
                    return CheckoutReservation(
                        account_id,
                        str(existing["claim_token"]),
                        plan_key,
                        interval,
                        existing["expires_at"],
                        request_key,
                        existing["session_id"],
                        existing["session_url"],
                    )
                raise CheckoutBusyError("an unexpired Checkout claim already exists")
            if existing is not None:
                await conn.execute(
                    "delete from checkout_claims where account_id=$1::uuid", account_id
                )
            await conn.execute(
                """insert into checkout_claims
                       (account_id,claim_token,plan_key,plan_interval,expires_at,
                        client_request_key)
                     values($1::uuid,$2,$3,$4,$5,$6)""",
                account_id,
                token,
                plan_key,
                interval,
                expires_at,
                request_key,
            )
        return CheckoutReservation(
            account_id, str(token), plan_key, interval, expires_at, request_key
        )

    async def attach_session(
        self, reservation: CheckoutReservation, session_id: str, session_url: str
    ) -> bool:
        _validate_session_identity(session_id, session_url)
        async with self.pool.acquire() as conn:
            updated = await conn.fetchval(
                """update checkout_claims set session_id=$3,session_url=$4
                     where account_id=$1::uuid and claim_token=$2::uuid
                     returning account_id""",
                reservation.account_id,
                reservation.claim_token,
                session_id,
                session_url,
            )
        return updated is not None

    async def release(self, reservation: CheckoutReservation) -> bool:
        async with self.pool.acquire() as conn:
            deleted = await conn.fetchval(
                """delete from checkout_claims
                     where account_id=$1::uuid and claim_token=$2::uuid returning account_id""",
                reservation.account_id,
                reservation.claim_token,
            )
        return deleted is not None

    async def completed_during_creation(self, reservation: CheckoutReservation) -> bool:
        """Detect an authorized webhook that consumed this claim before attach."""
        async with self.pool.acquire() as conn:
            row = await conn.fetchrow(
                """select a.stripe_subscription_id,c.claim_token
                     from billing_accounts a
                     left join checkout_claims c on c.account_id=a.id
                     where a.id=$1::uuid""",
                reservation.account_id,
            )
        return bool(
            row is not None and row["stripe_subscription_id"] and row["claim_token"] is None
        )

    async def create(
        self,
        creator: CheckoutCreator,
        *,
        account_id: str,
        customer_id: str | None,
        plan_key: str,
        interval: str,
        lookup_key: str,
        expected_currency: str,
        expected_unit_amount: int,
        expected_interval: str,
        request_key: str | None = None,
        customer_email: str | None = None,
    ) -> tuple[str, str]:
        reservation = await self.reserve(account_id, plan_key, interval, request_key=request_key)
        if reservation.session_id and reservation.session_url:
            return reservation.session_id, reservation.session_url
        try:
            session_id, url = await creator.create_checkout_session(
                account_id=account_id,
                customer_id=customer_id,
                lookup_key=lookup_key,
                expected_currency=expected_currency,
                expected_unit_amount=expected_unit_amount,
                expected_interval=expected_interval,
                claim_token=reservation.claim_token,
                expires_at=reservation.expires_at,
                customer_email=customer_email,
                plan_key=plan_key,
                interval=interval,
            )
        except CheckoutCreationRejected:
            await self.release(reservation)
            raise
        try:
            _validate_session_identity(session_id, url)
        except ValueError as exc:
            raise RuntimeError("Checkout creator returned an invalid Session identity") from exc
        # A generic Stripe/network exception has an unknown outcome. Keep this claim;
        # the caller must retry the same request key/claim token so Stripe idempotency
        # can return the original Session instead of opening a second payable Session.
        if not await self.attach_session(reservation, session_id, url):
            if await self.completed_during_creation(reservation):
                return session_id, url
            raise RuntimeError(
                "Checkout claim identity changed while Stripe was creating a session"
            )
        return session_id, url
