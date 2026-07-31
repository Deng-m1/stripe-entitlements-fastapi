from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Protocol

import asyncpg


class CheckoutBusyError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class CheckoutReservation:
    account_id: str
    claim_token: str
    plan_key: str
    interval: str
    expires_at: datetime


class CheckoutCreator(Protocol):
    async def create_checkout_session(
        self,
        *,
        account_id: str,
        customer_id: str | None,
        lookup_key: str,
        claim_token: str,
        expires_at: datetime,
    ) -> tuple[str, str]: ...


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
        ttl: timedelta = timedelta(minutes=35),
        now: datetime | None = None,
    ) -> CheckoutReservation:
        now = now or datetime.now(UTC)
        token = uuid.uuid4()
        expires_at = now + ttl
        async with self.pool.acquire() as conn, conn.transaction():
            row = await conn.fetchrow(
                """insert into checkout_claims
                       (account_id,claim_token,plan_key,plan_interval,expires_at)
                     values($1::uuid,$2,$3,$4,$5)
                     on conflict(account_id) do update set
                       claim_token=excluded.claim_token,session_id=null,
                       plan_key=excluded.plan_key,plan_interval=excluded.plan_interval,
                       expires_at=excluded.expires_at,created_at=now()
                     where checkout_claims.expires_at <= $6
                     returning claim_token""",
                account_id,
                token,
                plan_key,
                interval,
                expires_at,
                now,
            )
            if row is None:
                raise CheckoutBusyError("an unexpired Checkout claim already exists")
        return CheckoutReservation(account_id, str(token), plan_key, interval, expires_at)

    async def attach_session(self, reservation: CheckoutReservation, session_id: str) -> bool:
        async with self.pool.acquire() as conn:
            updated = await conn.fetchval(
                """update checkout_claims set session_id=$3
                     where account_id=$1::uuid and claim_token=$2::uuid
                     returning account_id""",
                reservation.account_id,
                reservation.claim_token,
                session_id,
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

    async def create(
        self,
        creator: CheckoutCreator,
        *,
        account_id: str,
        customer_id: str | None,
        plan_key: str,
        interval: str,
        lookup_key: str,
    ) -> tuple[str, str]:
        reservation = await self.reserve(account_id, plan_key, interval)
        try:
            session_id, url = await creator.create_checkout_session(
                account_id=account_id,
                customer_id=customer_id,
                lookup_key=lookup_key,
                claim_token=reservation.claim_token,
                expires_at=reservation.expires_at,
            )
        except Exception:
            await self.release(reservation)
            raise
        if not await self.attach_session(reservation, session_id):
            raise RuntimeError(
                "Checkout claim identity changed while Stripe was creating a session"
            )
        return session_id, url
