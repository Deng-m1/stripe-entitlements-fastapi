from __future__ import annotations

import uuid
from collections.abc import Mapping
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol
from urllib.parse import urlsplit

import asyncpg

from .catalog import CreditPack, PlanCatalog
from .credit_amount import CreditAmount, checked_add_atoms
from .subscription_state import spendable_subscription_atoms
from .types import ProcessResult

_PACK_SCHEMA_VERSION = "1"


class CreditPackBusyError(RuntimeError):
    pass


class CreditPackConflictError(ValueError):
    pass


class CreditPackCheckoutRejected(RuntimeError):
    """A deterministic remote precondition failure; the order remains replayable."""


@dataclass(frozen=True, slots=True)
class CreditPackReservation:
    order_id: str
    account_id: str
    request_key: str
    stripe_request_key: str
    pack_key: str
    credits: CreditAmount
    price_amount: int
    currency: str
    expires_days: int
    lookup_key: str
    request_customer_id: str | None
    claim_expires_at: datetime
    session_id: str | None = None
    session_url: str | None = None
    request_snapshot_version: int | None = None
    stripe_request_snapshot: Mapping[str, Any] | None = None


class CreditPackCheckoutCreator(Protocol):
    async def prepare_credit_pack_checkout_session(
        self,
        *,
        order_id: str,
        account_id: str,
        customer_id: str | None,
        customer_email: str | None,
        lookup_key: str,
        expected_currency: str,
        expected_unit_amount: int,
        pack_key: str,
        pack_credits: str,
        expires_days: int,
        expires_at: datetime,
    ) -> Mapping[str, Any]: ...

    async def create_checkout_session_from_snapshot(
        self, snapshot: Mapping[str, Any]
    ) -> tuple[str, str]: ...


def _visible(value: Any, *, field: str, max_bytes: int) -> str:
    if (
        type(value) is not str
        or not value
        or value != value.strip()
        or len(value.encode("utf-8")) > max_bytes
        or any(not character.isprintable() for character in value)
    ):
        raise ValueError(f"{field} must contain 1 to {max_bytes} visible bytes without padding")
    return value


def _stripe_id(value: Any, prefix: str) -> str | None:
    candidate = value.get("id") if isinstance(value, Mapping) else value
    if not isinstance(candidate, str) or not candidate.startswith(prefix):
        return None
    try:
        return _visible(candidate, field=f"Stripe {prefix} identity", max_bytes=512)
    except ValueError:
        return None


def _stripe_integer(value: Any) -> int | None:
    return value if type(value) is int and value >= 0 else None


def _metadata(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _safe_session_url(value: str) -> str:
    value = _visible(value, field="Checkout Session URL", max_bytes=2048)
    parsed = urlsplit(value)
    if (
        parsed.scheme != "https"
        or not parsed.netloc
        or parsed.username is not None
        or parsed.password is not None
    ):
        raise ValueError("Checkout Session URL must be an origin-safe HTTPS URL")
    return value


async def pack_balance_atoms(
    conn: asyncpg.Connection,
    account_id: Any,
    *,
    lock: bool = False,
    as_of: datetime | None = None,
) -> int:
    effective_now = as_of or await conn.fetchval("select clock_timestamp()")
    suffix = " for update" if lock else ""
    rows = await conn.fetch(
        """select id,remaining_credits from credit_funding_lots
             where account_id=$1 and status='active' and expires_at > $2
             order by expires_at,id"""
        + suffix,
        account_id,
        effective_now,
    )
    return sum(int(row["remaining_credits"]) for row in rows)


async def total_balance_atoms(conn: asyncpg.Connection, account: Mapping[str, Any]) -> int:
    effective_now = await conn.fetchval("select clock_timestamp()")
    return spendable_subscription_atoms(account, as_of=effective_now) + await pack_balance_atoms(
        conn, account["id"], as_of=effective_now
    )


async def _record_debt_collection(
    conn: asyncpg.Connection,
    *,
    debt: Mapping[str, Any],
    amount: int,
    grant_epoch: int,
    source_type: str,
    lot_id: Any = None,
) -> None:
    """Persist the exact funding source used to collect reversible pack debt."""

    debit_key = f"pack-debt:{uuid.uuid4()}"
    await conn.execute(
        """insert into credit_debits(
               idempotency_key,account_id,amount,grant_epoch,kind,clawback_order_id)
             values($1,$2,$3,$4,'credit_pack_debt_collection',$5)""",
        debit_key,
        debt["account_id"],
        amount,
        grant_epoch,
        debt["order_id"],
    )
    if source_type == "subscription":
        await conn.execute(
            """insert into credit_debit_allocations(
                   debit_idempotency_key,account_id,source_type,
                   subscription_grant_epoch,amount)
                 values($1,$2,'subscription',$3,$4)""",
            debit_key,
            debt["account_id"],
            grant_epoch,
            amount,
        )
    else:
        await conn.execute(
            """insert into credit_debit_allocations(
                   debit_idempotency_key,account_id,source_type,funding_lot_id,amount)
                 values($1,$2,'credit_pack',$3,$4)""",
            debit_key,
            debt["account_id"],
            lot_id,
            amount,
        )


async def collect_pack_debts_from_lot(
    conn: asyncpg.Connection,
    *,
    account_id: Any,
    lot_id: Any,
    available_atoms: int,
) -> int:
    """Collect oldest durable pack debt from newly funded atoms before exposure."""

    remaining = available_atoms
    debts = await conn.fetch(
        """select * from credit_pack_clawback_debts
             where account_id=$1
               and collected_credits + released_credits < target_credits
             order by created_at,order_id for update""",
        account_id,
    )
    grant_epoch = int(
        await conn.fetchval("select grant_epoch from billing_accounts where id=$1", account_id)
    )
    for debt in debts:
        amount = min(
            remaining,
            int(debt["target_credits"])
            - int(debt["collected_credits"])
            - int(debt["released_credits"]),
        )
        if amount <= 0:
            break
        await conn.execute(
            """update credit_pack_clawback_debts
                  set collected_credits=collected_credits+$2,updated_at=now()
                where order_id=$1""",
            debt["order_id"],
            amount,
        )
        await _record_debt_collection(
            conn,
            debt=debt,
            amount=amount,
            grant_epoch=grant_epoch,
            source_type="credit_pack",
            lot_id=lot_id,
        )
        remaining -= amount
    collected = available_atoms - remaining
    if collected:
        await conn.execute(
            """update credit_funding_lots
                  set remaining_credits=remaining_credits-$2,updated_at=now()
                where id=$1 and remaining_credits >= $2""",
            lot_id,
            collected,
        )
    return collected


async def collect_pack_debts_from_subscription(
    conn: asyncpg.Connection,
    *,
    account_id: Any,
    grant_epoch: int,
    event_id: str,
) -> int:
    """Consume current subscription atoms against cross-epoch pack debt."""

    account = await conn.fetchrow(
        "select credits_balance from billing_accounts where id=$1 for update", account_id
    )
    if account is None:
        raise KeyError("account not found")
    balance = int(account["credits_balance"])
    original = balance
    debts = await conn.fetch(
        """select * from credit_pack_clawback_debts
             where account_id=$1
               and collected_credits + released_credits < target_credits
             order by created_at,order_id for update""",
        account_id,
    )
    for debt in debts:
        amount = min(
            balance,
            int(debt["target_credits"])
            - int(debt["collected_credits"])
            - int(debt["released_credits"]),
        )
        if amount <= 0:
            break
        balance -= amount
        await conn.execute(
            """update credit_pack_clawback_debts
                  set collected_credits=collected_credits+$2,updated_at=now()
                where order_id=$1""",
            debt["order_id"],
            amount,
        )
        await _record_debt_collection(
            conn,
            debt=debt,
            amount=amount,
            grant_epoch=grant_epoch,
            source_type="subscription",
        )
        await conn.execute(
            """insert into credit_ledger(
                   account_id,delta,balance_after,reason,grant_epoch,stripe_event_id)
                 values($1,$2,$3,'credit_pack_debt_collection',$4,$5)""",
            account_id,
            -amount,
            balance,
            grant_epoch,
            event_id,
        )
    if balance != original:
        await conn.execute(
            "update billing_accounts set credits_balance=$2,updated_at=now() where id=$1",
            account_id,
            balance,
        )
    return original - balance


class CreditPackCoordinator:
    """Crash-safe one-time Checkout reservation and same-key remote recovery."""

    def __init__(self, pool: asyncpg.Pool, catalog: PlanCatalog) -> None:
        self.pool = pool
        self.catalog = catalog

    @staticmethod
    def _reservation(row: Mapping[str, Any]) -> CreditPackReservation:
        return CreditPackReservation(
            order_id=str(row["id"]),
            account_id=str(row["account_id"]),
            request_key=str(row["client_idempotency_key"]),
            stripe_request_key=str(row["stripe_request_key"]),
            pack_key=str(row["pack_key"]),
            credits=CreditAmount.from_atoms(int(row["pack_credits"])),
            price_amount=int(row["price_amount"]),
            currency=str(row["currency"]),
            expires_days=int(row["expires_days"]),
            lookup_key=str(row["price_lookup_key"]),
            request_customer_id=row["request_customer_id"],
            claim_expires_at=row["claim_expires_at"],
            session_id=row["stripe_checkout_session_id"],
            session_url=row["session_url"],
            request_snapshot_version=row["request_snapshot_version"],
            stripe_request_snapshot=row["stripe_request_snapshot"],
        )

    async def reserve(
        self,
        account_id: str,
        pack: CreditPack,
        request_key: str,
        *,
        ttl: timedelta = timedelta(hours=23),
    ) -> CreditPackReservation:
        request_key = _visible(request_key, field="Idempotency-Key", max_bytes=200)
        if ttl <= timedelta(0) or ttl > timedelta(hours=23, minutes=59):
            raise ValueError("credit-pack Checkout TTL must be within Stripe's 24-hour bound")
        order_id = uuid.uuid4()
        async with self.pool.acquire() as conn, conn.transaction():
            account = await conn.fetchrow(
                "select * from billing_accounts where id=$1::uuid for update", account_id
            )
            if account is None:
                raise KeyError("billing account not found")
            # PostgreSQL ``now()`` is fixed at transaction start.  A reservation can
            # spend time waiting for the account lock, so all expiry decisions and
            # the new claim TTL must start from a wall-clock sample taken only after
            # that serialization point.
            database_now = await conn.fetchval("select clock_timestamp()")
            assert isinstance(database_now, datetime)
            existing = await conn.fetchrow(
                """select o.* from credit_pack_orders o
                     where account_id=$1::uuid and client_idempotency_key=$2 for update""",
                account_id,
                request_key,
            )
            if existing is not None:
                expected_lookup_key = self.catalog.credit_pack_lookup_key(pack.key)
                if (
                    existing["pack_key"] != pack.key
                    or int(existing["pack_credits"]) != pack.credits.atoms
                    or int(existing["price_amount"]) != pack.price_usd * 100
                    or existing["currency"] != pack.currency
                    or int(existing["expires_days"]) != pack.expires_days
                    or existing["price_lookup_key"] != expected_lookup_key
                ):
                    raise CreditPackConflictError(
                        "Idempotency-Key was already used for a different credit pack"
                    )
                if existing["checkout_status"] == "expired":
                    raise CreditPackConflictError(
                        "this credit-pack Checkout expired; start a new intent with a new "
                        "Idempotency-Key"
                    )
                if existing["claim_expires_at"] <= database_now:
                    raise CreditPackConflictError(
                        "the safe same-key Checkout recovery window expired; operator "
                        "reconciliation is required before starting a new intent"
                    )
                return self._reservation(existing)
            if account["stripe_customer_id"] is None:
                checkout_claim = await conn.fetchval(
                    """select exists(
                           select 1 from checkout_claims
                            where account_id=$1::uuid and expires_at > $2
                         )""",
                    account_id,
                    database_now,
                )
                pack_claim = await conn.fetchval(
                    """select exists(
                           select 1 from credit_pack_orders
                            where account_id=$1::uuid and payment_status='pending'
                              and checkout_status <> 'expired' and claim_expires_at > $2
                         )""",
                    account_id,
                    database_now,
                )
                if checkout_claim or pack_claim:
                    raise CreditPackBusyError(
                        "the first Stripe Customer Checkout is already in progress"
                    )
            expires_at = database_now + ttl
            stripe_key = f"credit-pack:{order_id}"
            row = await conn.fetchrow(
                """insert into credit_pack_orders(
                       id,account_id,client_idempotency_key,stripe_request_key,pack_key,
                       pack_credits,price_amount,currency,expires_days,price_lookup_key,
                       request_customer_id,claim_expires_at,request_snapshot_version)
                     values($1,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,0)
                     returning *""",
                order_id,
                account_id,
                request_key,
                stripe_key,
                pack.key,
                pack.credits.atoms,
                pack.price_usd * 100,
                pack.currency,
                pack.expires_days,
                self.catalog.credit_pack_lookup_key(pack.key),
                account["stripe_customer_id"],
                expires_at,
            )
            assert row is not None
            return self._reservation(row)

    async def _existing_for_create(
        self, account_id: str, pack_key: str, request_key: str
    ) -> CreditPackReservation | None:
        async with self.pool.acquire() as conn:
            row = await conn.fetchrow(
                """select * from credit_pack_orders
                     where account_id=$1::uuid and client_idempotency_key=$2""",
                account_id,
                request_key,
            )
            if row is None:
                return None
            database_now = await conn.fetchval("select clock_timestamp()")
        if row["pack_key"] != pack_key:
            raise CreditPackConflictError(
                "Idempotency-Key was already used for a different credit pack"
            )
        if row["checkout_status"] == "expired":
            raise CreditPackConflictError(
                "this credit-pack Checkout expired; start a new intent with a new Idempotency-Key"
            )
        if row["claim_expires_at"] <= database_now:
            raise CreditPackConflictError(
                "the safe same-key Checkout recovery window expired; operator "
                "reconciliation is required before starting a new intent"
            )
        return self._reservation(row)

    async def freeze_request_snapshot(
        self, reservation: CreditPackReservation, snapshot: Mapping[str, Any]
    ) -> Mapping[str, Any]:
        async with self.pool.acquire() as conn:
            row = await conn.fetchrow(
                """update credit_pack_orders set request_snapshot_version=1,
                         stripe_request_snapshot=$2::jsonb,updated_at=now()
                     where id=$1::uuid and request_snapshot_version=0
                       and stripe_request_snapshot is null
                     returning *""",
                reservation.order_id,
                dict(snapshot),
            )
            if row is None:
                row = await conn.fetchrow(
                    "select * from credit_pack_orders where id=$1::uuid",
                    reservation.order_id,
                )
        if (
            row is None
            or row["request_snapshot_version"] != 1
            or not isinstance(row["stripe_request_snapshot"], Mapping)
        ):
            raise CreditPackConflictError(
                "credit-pack Checkout request snapshot could not be frozen safely"
            )
        return row["stripe_request_snapshot"]

    @staticmethod
    def _validated_frozen_snapshot(
        reservation: CreditPackReservation,
    ) -> dict[str, Any]:
        from .stripe_request_snapshots import (
            StripeRequestSnapshotError,
            validate_checkout_request_snapshot,
        )

        try:
            return validate_checkout_request_snapshot(
                reservation.stripe_request_snapshot,
                expected_kind="credit_pack",
                expected_account_id=reservation.account_id,
                expected_request_identity=reservation.order_id,
                expected_lookup_key=reservation.lookup_key,
                expected_currency=reservation.currency,
                expected_unit_amount=reservation.price_amount,
                expected_offering_key=reservation.pack_key,
                expected_expires_at=int(reservation.claim_expires_at.timestamp()),
                expected_customer_id=reservation.request_customer_id,
                expected_pack_credits=str(reservation.credits),
                expected_expires_days=reservation.expires_days,
            )
        except StripeRequestSnapshotError as exc:
            raise CreditPackConflictError(
                "the persisted credit-pack Checkout request snapshot is invalid; "
                "operator reconciliation is required"
            ) from exc

    async def _execute_frozen(
        self,
        creator: CreditPackCheckoutCreator,
        reservation: CreditPackReservation,
        snapshot: Mapping[str, Any],
    ) -> tuple[str, str]:
        if reservation.session_id and reservation.session_url:
            return reservation.session_id, reservation.session_url
        session_id, session_url = await creator.create_checkout_session_from_snapshot(snapshot)
        session_id = _visible(session_id, field="Checkout Session id", max_bytes=255)
        session_url = _safe_session_url(session_url)
        async with self.pool.acquire() as conn:
            attached = await conn.fetchval(
                """update credit_pack_orders
                      set stripe_checkout_session_id=coalesce(stripe_checkout_session_id,$2),
                          session_url=$3,
                          checkout_status=case when checkout_status='reserved'
                                               then 'session_created'
                                               else checkout_status end,
                          updated_at=now()
                    where id=$1::uuid
                      and request_snapshot_version=1
                      and stripe_request_snapshot is not null
                      and (stripe_checkout_session_id is null
                           or stripe_checkout_session_id=$2)
                    returning id""",
                reservation.order_id,
                session_id,
                session_url,
            )
            if attached is None:
                existing = await conn.fetchrow(
                    "select * from credit_pack_orders where id=$1::uuid",
                    reservation.order_id,
                )
                if existing is None or existing["stripe_checkout_session_id"] != session_id:
                    raise RuntimeError("credit-pack order changed during Checkout creation")
        return session_id, session_url

    async def recover_frozen(
        self,
        creator: CreditPackCheckoutCreator,
        *,
        account_id: str,
        pack_key: str,
        request_key: str,
    ) -> tuple[str, str] | None:
        """Replay an exact v1 order before consulting the mutable pack catalog."""

        pack_key = _visible(pack_key, field="pack_key", max_bytes=64)
        request_key = _visible(request_key, field="Idempotency-Key", max_bytes=200)
        reservation = await self._existing_for_create(account_id, pack_key, request_key)
        if reservation is None or reservation.request_snapshot_version != 1:
            return None
        snapshot = self._validated_frozen_snapshot(reservation)
        return await self._execute_frozen(creator, reservation, snapshot)

    async def create(
        self,
        creator: CreditPackCheckoutCreator,
        *,
        account_id: str,
        customer_id: str | None,
        customer_email: str | None,
        pack_key: str,
        request_key: str,
    ) -> tuple[str, str]:
        # These are call-time observations kept for source compatibility. The
        # durable reservation below is the only authority for replayed Stripe
        # parameters because either value may change after an early webhook.
        del customer_id, customer_email
        reservation = await self._existing_for_create(account_id, pack_key, request_key)
        if reservation is None:
            pack = self.catalog.require_credit_pack(pack_key)
            reservation = await self.reserve(account_id, pack, request_key)
        if reservation.session_id and reservation.session_url:
            return reservation.session_id, reservation.session_url
        from .stripe_request_snapshots import validate_checkout_request_snapshot

        if reservation.request_snapshot_version is None:
            raise CreditPackConflictError(
                "this credit-pack order predates durable request snapshots; operator "
                "reconciliation is required"
            )
        if reservation.request_snapshot_version == 1:
            snapshot = self._validated_frozen_snapshot(reservation)
        else:
            prepared = await creator.prepare_credit_pack_checkout_session(
                order_id=reservation.order_id,
                account_id=reservation.account_id,
                customer_id=reservation.request_customer_id,
                customer_email=None,
                lookup_key=reservation.lookup_key,
                expected_currency=reservation.currency,
                expected_unit_amount=reservation.price_amount,
                pack_key=reservation.pack_key,
                pack_credits=str(reservation.credits),
                expires_days=reservation.expires_days,
                expires_at=reservation.claim_expires_at,
            )
            snapshot = validate_checkout_request_snapshot(
                prepared,
                expected_kind="credit_pack",
                expected_account_id=reservation.account_id,
                expected_request_identity=reservation.order_id,
                expected_lookup_key=reservation.lookup_key,
                expected_currency=reservation.currency,
                expected_unit_amount=reservation.price_amount,
                expected_offering_key=reservation.pack_key,
                expected_expires_at=int(reservation.claim_expires_at.timestamp()),
                expected_customer_id=reservation.request_customer_id,
                expected_pack_credits=str(reservation.credits),
                expected_expires_days=reservation.expires_days,
            )
            snapshot = self._validated_frozen_snapshot(
                replace(
                    reservation,
                    request_snapshot_version=1,
                    stripe_request_snapshot=await self.freeze_request_snapshot(
                        reservation, snapshot
                    ),
                )
            )
        return await self._execute_frozen(creator, reservation, snapshot)


class CreditPackEventProcessor:
    """Projects paid, refund, dispute, and Checkout facts into source-aware lots."""

    def __init__(self, catalog: PlanCatalog, product_line: str) -> None:
        self.catalog = catalog
        self.product_line = product_line

    async def _incident(
        self,
        conn: asyncpg.Connection,
        *,
        kind: str,
        event: Mapping[str, Any],
        dedupe_key: str,
        account_id: Any = None,
        detail: Mapping[str, Any] | None = None,
    ) -> None:
        await conn.execute(
            """insert into billing_incidents(
                   kind,dedupe_key,stripe_event_id,account_id,detail)
                 values($1,$2,$3,$4::uuid,$5::jsonb)
                 on conflict(kind,dedupe_key) where resolved_at is null do update set
                   stripe_event_id=excluded.stripe_event_id,
                   account_id=coalesce(excluded.account_id,billing_incidents.account_id),
                   detail=excluded.detail,
                   seen_count=billing_incidents.seen_count+1,
                   last_seen_at=clock_timestamp()""",
            kind,
            dedupe_key,
            event.get("id"),
            account_id,
            dict(detail or {}),
        )

    def _order_metadata(self, obj: Mapping[str, Any]) -> tuple[str, str, str] | None:
        metadata = _metadata(obj.get("metadata"))
        if (
            metadata.get("billing_kind") != "credit_pack"
            or metadata.get("pack_schema_version") != _PACK_SCHEMA_VERSION
            or metadata.get("product_line") != self.product_line
        ):
            return None
        order_id = metadata.get("credit_pack_order_id")
        account_id = metadata.get("account_id")
        pack_key = metadata.get("pack_key")
        try:
            order_id = str(uuid.UUID(str(order_id)))
            account_id = str(uuid.UUID(str(account_id)))
        except (ValueError, TypeError, AttributeError):
            return None
        if not isinstance(pack_key, str):
            return None
        return order_id, account_id, pack_key

    def _metadata_matches_order(
        self,
        obj: Mapping[str, Any],
        order: Mapping[str, Any],
    ) -> bool:
        """Bind every Stripe metadata snapshot field to the durable order facts."""

        metadata = _metadata(obj.get("metadata"))
        expected = {
            "billing_kind": "credit_pack",
            "pack_schema_version": _PACK_SCHEMA_VERSION,
            "product_line": self.product_line,
            "credit_pack_order_id": str(order["id"]),
            "account_id": str(order["account_id"]),
            "pack_key": str(order["pack_key"]),
            "pack_credits": str(CreditAmount.from_atoms(int(order["pack_credits"]))),
            "price_amount": str(order["price_amount"]),
            "currency": str(order["currency"]),
            "expires_days": str(order["expires_days"]),
            "lookup_key": str(order["price_lookup_key"]),
        }
        return all(metadata.get(key) == value for key, value in expected.items())

    async def _locked_order(
        self,
        conn: asyncpg.Connection,
        *,
        order_id: str,
        account_id: str,
    ) -> tuple[asyncpg.Record, asyncpg.Record] | None:
        snapshot = await conn.fetchrow(
            "select account_id from credit_pack_orders where id=$1::uuid", order_id
        )
        if snapshot is None or str(snapshot["account_id"]) != account_id:
            return None
        account = await conn.fetchrow(
            "select * from billing_accounts where id=$1::uuid for update", account_id
        )
        if account is None:
            return None
        order = await conn.fetchrow(
            "select * from credit_pack_orders where id=$1::uuid for update", order_id
        )
        if order is None or order["account_id"] != account["id"]:
            return None
        return account, order

    async def payment_succeeded(
        self, conn: asyncpg.Connection, event: Mapping[str, Any]
    ) -> ProcessResult:
        obj = event["data"]["object"]
        assert isinstance(obj, Mapping)
        identity = self._order_metadata(obj)
        payment_intent_id = _stripe_id(obj.get("id"), "pi_")
        if identity is None:
            raw_metadata = _metadata(obj.get("metadata"))
            if raw_metadata.get("billing_kind") == "credit_pack" and payment_intent_id:
                await self._incident(
                    conn,
                    kind="credit_pack_payment_metadata_invalid",
                    event=event,
                    dedupe_key=payment_intent_id,
                )
            return ProcessResult(
                "ignored", "PaymentIntent is not an authorized credit-pack payment"
            )
        if payment_intent_id is None:
            return ProcessResult(
                "ignored", "PaymentIntent is not an authorized credit-pack payment"
            )
        order_id, account_id, pack_key = identity
        locked = await self._locked_order(conn, order_id=order_id, account_id=account_id)
        if locked is None:
            await self._incident(
                conn,
                kind="credit_pack_payment_identity_conflict",
                event=event,
                dedupe_key=payment_intent_id,
                detail={"order_id": order_id},
            )
            return ProcessResult("ignored", "credit-pack order identity is missing or conflicting")
        account, order = locked
        customer_id = _stripe_id(obj.get("customer"), "cus_")
        charge_id = _stripe_id(obj.get("latest_charge"), "ch_")
        authorized_amount = _stripe_integer(obj.get("amount"))
        amount = _stripe_integer(obj.get("amount_received"))
        currency = obj.get("currency")
        shape_matches = bool(
            obj.get("object") == "payment_intent"
            and obj.get("status") == "succeeded"
            and customer_id
            and charge_id
            and authorized_amount == int(order["price_amount"])
            and amount == int(order["price_amount"])
            and currency == order["currency"]
            and pack_key == order["pack_key"]
            and self._metadata_matches_order(obj, order)
            and (order["stripe_payment_intent_id"] in {None, payment_intent_id})
            and (order["stripe_charge_id"] in {None, charge_id})
            and (order["request_customer_id"] in {None, customer_id})
            and (order["stripe_customer_id"] in {None, customer_id})
            and (account["stripe_customer_id"] in {None, customer_id})
        )
        if not shape_matches:
            await self._incident(
                conn,
                kind="credit_pack_payment_contract_mismatch",
                event=event,
                dedupe_key=payment_intent_id,
                account_id=account["id"],
                detail={"order_id": order_id},
            )
            return ProcessResult("ignored", "credit-pack PaymentIntent does not match its order")
        existing_lot = await conn.fetchrow(
            "select * from credit_funding_lots where order_id=$1::uuid for update", order_id
        )
        event_created = _stripe_integer(event.get("created"))
        if event_created is None:
            return ProcessResult("ignored", "credit-pack payment has no valid creation time")
        paid_at = datetime.fromtimestamp(event_created, tz=UTC)
        payment_status = str(order["payment_status"])
        if payment_status == "pending":
            payment_status = "paid"
        await conn.execute(
            """update credit_pack_orders set
                   stripe_payment_intent_id=$2,stripe_charge_id=coalesce(stripe_charge_id,$3),
                   stripe_customer_id=$4,amount_paid=$5,payment_status=$6,
                   paid_at=coalesce(paid_at,$7),
                   checkout_status=case
                     when stripe_checkout_session_id is null then checkout_status
                     when checkout_status='expired' then checkout_status
                     else 'completed' end,
                   updated_at=now()
                 where id=$1""",
            order["id"],
            payment_intent_id,
            charge_id,
            customer_id,
            amount,
            payment_status,
            paid_at,
        )
        if account["stripe_customer_id"] is None:
            await conn.execute(
                "update billing_accounts set stripe_customer_id=$2,updated_at=now() where id=$1",
                account["id"],
                customer_id,
            )
        if existing_lot is not None:
            return ProcessResult("replayed", "credit-pack funding lot already exists", account_id)
        refunded_atoms = int(order["refunded_credits"])
        remaining = int(order["pack_credits"]) - refunded_atoms
        funding_terminal = (
            refunded_atoms == int(order["pack_credits"]) or payment_status == "disputed"
        )
        funding_status = "disputed" if payment_status == "disputed" else "refunded"
        lot_expires_at = paid_at + timedelta(days=int(order["expires_days"]))
        financially_expired = bool(
            not funding_terminal
            and await conn.fetchval("select $1::timestamptz <= clock_timestamp()", lot_expires_at)
        )
        lot_id = uuid.uuid4()
        lot = await conn.fetchrow(
            """insert into credit_funding_lots(
                   id,order_id,account_id,original_credits,remaining_credits,
                   expired_credits,cash_clawed_back_credits,expires_at,status,closed_at)
                 values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *""",
            lot_id,
            order["id"],
            account["id"],
            order["pack_credits"],
            remaining if not funding_terminal and not financially_expired else 0,
            remaining if financially_expired else 0,
            refunded_atoms,
            lot_expires_at,
            funding_status
            if funding_terminal
            else ("expired" if financially_expired else "active"),
            paid_at
            if funding_terminal
            else (await conn.fetchval("select clock_timestamp()") if financially_expired else None),
        )
        assert lot is not None
        if not funding_terminal and not financially_expired and remaining:
            await collect_pack_debts_from_lot(
                conn,
                account_id=account["id"],
                lot_id=lot["id"],
                available_atoms=remaining,
            )
        return ProcessResult("handled", "credit-pack funding granted", account_id)

    async def checkout_event(
        self, conn: asyncpg.Connection, event: Mapping[str, Any]
    ) -> ProcessResult | None:
        obj = event["data"]["object"]
        assert isinstance(obj, Mapping)
        session_id = _stripe_id(obj.get("id"), "cs_")
        if session_id is None:
            return None
        snapshot = await conn.fetchrow(
            "select id,account_id from credit_pack_orders where stripe_checkout_session_id=$1",
            session_id,
        )
        metadata_identity = self._order_metadata(obj)
        if snapshot is None:
            if metadata_identity is None:
                return None
            metadata_order_id, metadata_account_id, _ = metadata_identity
            snapshot = await conn.fetchrow(
                """select id,account_id from credit_pack_orders
                     where id=$1::uuid and account_id=$2::uuid""",
                metadata_order_id,
                metadata_account_id,
            )
            if snapshot is None:
                return ProcessResult("ignored", "credit-pack Checkout order is missing")
        account = await conn.fetchrow(
            "select * from billing_accounts where id=$1 for update", snapshot["account_id"]
        )
        order = await conn.fetchrow(
            "select * from credit_pack_orders where id=$1 for update",
            snapshot["id"],
        )
        assert account is not None and order is not None
        if order["stripe_checkout_session_id"] not in {None, session_id}:
            return ProcessResult("ignored", "credit-pack Checkout Session identity is conflicting")
        expected_status = "expired" if event["type"] == "checkout.session.expired" else "complete"
        payment_status = obj.get("payment_status")
        customer_id = _stripe_id(obj.get("customer"), "cus_")
        session_contract_matches = bool(
            obj.get("object") == "checkout.session"
            and obj.get("mode") == "payment"
            and obj.get("status") == expected_status
            and payment_status
            in ({"unpaid"} if expected_status == "expired" else {"paid", "unpaid"})
            and obj.get("client_reference_id") == str(account["id"])
            and _stripe_integer(obj.get("amount_total")) == int(order["price_amount"])
            and obj.get("currency") == order["currency"]
            and metadata_identity == (str(order["id"]), str(account["id"]), str(order["pack_key"]))
            and self._metadata_matches_order(obj, order)
            and order["request_customer_id"] in {None, customer_id}
        )
        if not session_contract_matches:
            await self._incident(
                conn,
                kind="credit_pack_checkout_contract_mismatch",
                event=event,
                dedupe_key=session_id,
                account_id=account["id"],
            )
            return ProcessResult("ignored", "credit-pack Checkout contract is conflicting")
        if order["stripe_checkout_session_id"] is None:
            await conn.execute(
                """update credit_pack_orders set stripe_checkout_session_id=$2,
                       checkout_status='session_created',updated_at=now() where id=$1""",
                order["id"],
                session_id,
            )
        if event["type"] == "checkout.session.expired":
            if order["payment_status"] == "pending":
                await conn.execute(
                    """update credit_pack_orders set checkout_status='expired',session_url=null,
                         updated_at=now() where id=$1""",
                    order["id"],
                )
            return ProcessResult("handled", "credit-pack Checkout expired", str(account["id"]))
        payment_intent_id = _stripe_id(obj.get("payment_intent"), "pi_")
        if (
            payment_intent_id is None
            or customer_id is None
            or order["stripe_payment_intent_id"] not in {None, payment_intent_id}
            or order["stripe_customer_id"] not in {None, customer_id}
            or account["stripe_customer_id"] not in {None, customer_id}
        ):
            await self._incident(
                conn,
                kind="credit_pack_checkout_contract_mismatch",
                event=event,
                dedupe_key=session_id,
                account_id=account["id"],
            )
            return ProcessResult("ignored", "credit-pack Checkout identity is conflicting")
        await conn.execute(
            """update credit_pack_orders set checkout_status='completed',
                   stripe_payment_intent_id=coalesce(stripe_payment_intent_id,$2),
                   stripe_customer_id=coalesce(stripe_customer_id,$3),updated_at=now()
                 where id=$1 and (stripe_payment_intent_id is null
                                  or stripe_payment_intent_id=$2)""",
            order["id"],
            payment_intent_id,
            customer_id,
        )
        if account["stripe_customer_id"] is None:
            await conn.execute(
                "update billing_accounts set stripe_customer_id=$2,updated_at=now() where id=$1",
                account["id"],
                customer_id,
            )
        return ProcessResult(
            "handled",
            "credit-pack Checkout recorded; payment webhook remains authoritative",
            str(account["id"]),
        )

    async def clawback(
        self, conn: asyncpg.Connection, event: Mapping[str, Any]
    ) -> ProcessResult | None:
        raw = event["data"]["object"]
        assert isinstance(raw, Mapping)
        dispute = event["type"] == "charge.dispute.created"
        charge = raw.get("_resolved_charge") if dispute else raw
        if not isinstance(charge, Mapping):
            return None
        payment_intent = raw.get("_resolved_payment_intent")
        if not isinstance(payment_intent, Mapping):
            return None
        identity = self._order_metadata(payment_intent)
        payment_intent_id = _stripe_id(charge.get("payment_intent"), "pi_")
        if identity is None or payment_intent_id != _stripe_id(payment_intent.get("id"), "pi_"):
            return None
        order_id, account_id, pack_key = identity
        locked = await self._locked_order(conn, order_id=order_id, account_id=account_id)
        if locked is None:
            return ProcessResult("ignored", "credit-pack clawback order is missing")
        account, order = locked
        charge_id = _stripe_id(charge.get("id"), "ch_")
        customer_id = _stripe_id(charge.get("customer"), "cus_")
        amount = _stripe_integer(charge.get("amount"))
        charge_amount_refunded = _stripe_integer(charge.get("amount_refunded"))
        amount_refunded = amount if dispute else charge_amount_refunded
        payment_customer_id = _stripe_id(payment_intent.get("customer"), "cus_")
        payment_charge_id = _stripe_id(payment_intent.get("latest_charge"), "ch_")
        payment_amount = _stripe_integer(payment_intent.get("amount"))
        payment_amount_received = _stripe_integer(payment_intent.get("amount_received"))
        charge_refunded = charge.get("refunded")
        charge_disputed = charge.get("disputed")
        dispute_contract_matches = True
        if dispute:
            dispute_amount = _stripe_integer(raw.get("amount"))
            dispute_contract_matches = bool(
                _stripe_id(raw.get("id"), "dp_")
                and raw.get("object") == "dispute"
                and _stripe_id(raw.get("charge"), "ch_") == charge_id
                and dispute_amount is not None
                and dispute_amount > 0
                and amount is not None
                and dispute_amount <= amount
                and raw.get("currency") == order["currency"]
                and charge_disputed is True
            )
        if (
            charge_id is None
            or customer_id is None
            or amount is None
            or amount_refunded is None
            or charge_amount_refunded is None
            or charge.get("object") != "charge"
            or charge.get("paid") is not True
            or amount != int(order["price_amount"])
            or amount_refunded > amount
            or charge_amount_refunded > amount
            or (not dispute and amount_refunded <= 0)
            or not isinstance(charge_refunded, bool)
            or charge_refunded is not (charge_amount_refunded == amount)
            or not isinstance(charge_disputed, bool)
            or charge.get("currency") != order["currency"]
            or payment_intent.get("object") != "payment_intent"
            or payment_intent.get("status") != "succeeded"
            or payment_customer_id != customer_id
            or payment_charge_id != charge_id
            or payment_amount != amount
            or payment_amount_received != amount
            or payment_intent.get("currency") != order["currency"]
            or not self._metadata_matches_order(payment_intent, order)
            or not dispute_contract_matches
            or pack_key != order["pack_key"]
            or order["stripe_payment_intent_id"] not in {None, payment_intent_id}
            or order["stripe_charge_id"] not in {None, charge_id}
            or order["request_customer_id"] not in {None, customer_id}
            or order["stripe_customer_id"] not in {None, customer_id}
            or account["stripe_customer_id"] not in {None, customer_id}
        ):
            await self._incident(
                conn,
                kind="credit_pack_clawback_contract_mismatch",
                event=event,
                dedupe_key=charge_id or str(event["id"]),
                account_id=account["id"],
            )
            return ProcessResult("ignored", "credit-pack clawback does not match its order")
        # Refunds and disputes can arrive before payment_intent.succeeded. Once the
        # complete Charge/PaymentIntent contract has authenticated the Customer,
        # bind it now so another first-Customer Checkout cannot race this order.
        if account["stripe_customer_id"] is None:
            await conn.execute(
                "update billing_accounts set stripe_customer_id=$2,updated_at=now() where id=$1",
                account["id"],
                customer_id,
            )
        target_cash = amount if dispute else max(int(order["amount_refunded"]), amount_refunded)
        target_atoms = (
            int(order["pack_credits"])
            if dispute or target_cash >= amount
            else -(-int(order["pack_credits"]) * target_cash // amount)
        )
        previous_atoms = int(order["refunded_credits"])
        cash_status = (
            "disputed"
            if dispute
            else ("refunded" if target_cash >= amount else "partially_refunded")
        )
        if target_atoms <= previous_atoms:
            previous_cash = int(order["amount_refunded"])
            next_status = cash_status
            if target_cash > previous_cash or next_status != order["payment_status"]:
                await conn.execute(
                    """update credit_pack_orders set
                           stripe_payment_intent_id=coalesce(stripe_payment_intent_id,$2),
                           stripe_charge_id=coalesce(stripe_charge_id,$3),
                           stripe_customer_id=coalesce(stripe_customer_id,$4),amount_paid=$5,
                           amount_refunded=$6,payment_status=$7,updated_at=now()
                         where id=$1""",
                    order["id"],
                    payment_intent_id,
                    charge_id,
                    customer_id,
                    amount,
                    target_cash,
                    next_status,
                )
                if dispute:
                    await conn.execute(
                        """update credit_funding_lots set status='disputed',
                               closed_at=coalesce(closed_at,now()),updated_at=now()
                             where order_id=$1 and remaining_credits=0""",
                        order["id"],
                    )
                return ProcessResult(
                    "handled", "credit-pack clawback cash facts advanced", account_id
                )
            return ProcessResult(
                "replayed", "credit-pack clawback facts did not advance", account_id
            )
        delta = target_atoms - previous_atoms
        lot = await conn.fetchrow(
            "select * from credit_funding_lots where order_id=$1 for update", order["id"]
        )
        removed = 0
        if lot is not None:
            if lot["status"] == "active" and not await conn.fetchval(
                "select $1::timestamptz > clock_timestamp()", lot["expires_at"]
            ):
                await conn.execute(
                    """update credit_funding_lots
                          set expired_credits=expired_credits+remaining_credits,
                              status='expired',remaining_credits=0,
                              closed_at=now(),updated_at=now()
                        where id=$1""",
                    lot["id"],
                )
                lot = await conn.fetchrow(
                    "select * from credit_funding_lots where id=$1 for update", lot["id"]
                )
                assert lot is not None
            remaining_removed = (
                min(delta, int(lot["remaining_credits"])) if lot["status"] == "active" else 0
            )
            expired_removed = min(
                delta - remaining_removed,
                int(lot["expired_credits"]),
            )
            removed = remaining_removed + expired_removed
            cash_clawed_back = checked_add_atoms(
                int(lot["cash_clawed_back_credits"]),
                removed,
                field="cash-clawed-back pack credits",
            )
            terminal = dispute or target_atoms == int(order["pack_credits"])
            await conn.execute(
                """update credit_funding_lots set
                       remaining_credits=remaining_credits-$2,
                       expired_credits=expired_credits-$3,
                       cash_clawed_back_credits=$4,
                       status=case when $5 then $6 else status end,
                       closed_at=case when $5 then now() else closed_at end,
                       updated_at=now()
                     where id=$1""",
                lot["id"],
                remaining_removed,
                expired_removed,
                cash_clawed_back,
                terminal,
                "disputed" if dispute else "refunded",
            )
        # A clawback that arrives before the funding lot is projected simply lowers
        # the later grant. It is not debt because no product credit was ever spendable.
        missing = delta - removed if lot is not None else 0
        if missing > 0:
            debt = await conn.fetchrow(
                """select target_credits from credit_pack_clawback_debts
                     where order_id=$1 for update""",
                order["id"],
            )
            if debt is None:
                await conn.execute(
                    """insert into credit_pack_clawback_debts(
                           order_id,account_id,target_credits,collected_credits)
                         values($1,$2,$3,0)""",
                    order["id"],
                    account["id"],
                    missing,
                )
            else:
                target = checked_add_atoms(
                    int(debt["target_credits"]),
                    missing,
                    field="credit-pack clawback debt target",
                )
                await conn.execute(
                    """update credit_pack_clawback_debts
                          set target_credits=$2,updated_at=now() where order_id=$1""",
                    order["id"],
                    target,
                )
        await conn.execute(
            """update credit_pack_orders set
                   stripe_payment_intent_id=coalesce(stripe_payment_intent_id,$2),
                   stripe_charge_id=coalesce(stripe_charge_id,$3),
                   stripe_customer_id=coalesce(stripe_customer_id,$4),amount_paid=$5,
                   amount_refunded=$6,refunded_credits=$7,payment_status=$8,updated_at=now()
                 where id=$1""",
            order["id"],
            payment_intent_id,
            charge_id,
            customer_id,
            amount,
            target_cash,
            target_atoms,
            cash_status,
        )
        return ProcessResult(
            "handled",
            f"credit-pack clawback removed {CreditAmount.from_atoms(removed)} credits",
            account_id,
        )


__all__ = [
    "CreditPackBusyError",
    "CreditPackCheckoutRejected",
    "CreditPackConflictError",
    "CreditPackCoordinator",
    "CreditPackEventProcessor",
    "CreditPackReservation",
    "collect_pack_debts_from_lot",
    "collect_pack_debts_from_subscription",
    "pack_balance_atoms",
    "total_balance_atoms",
]
