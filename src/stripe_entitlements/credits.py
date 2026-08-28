from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Any, Literal
from uuid import UUID

import asyncpg

from .clawbacks import collect_clawback_debts
from .credit_amount import CreditAmount, checked_add_atoms
from .credit_packs import (
    collect_pack_debts_from_lot,
    collect_pack_debts_from_subscription,
    pack_balance_atoms,
)
from .subscription_state import (
    spendable_subscription_atoms,
    subscription_credits_are_spendable,
)

_ZERO_CREDIT_AMOUNT = CreditAmount.from_atoms(0)


class InsufficientCreditsError(RuntimeError):
    pass


class CreditsUnavailableError(RuntimeError):
    pass


class CreditDebitOwnerMismatchError(LookupError):
    pass


def _validate_idempotency_key(value: str) -> str:
    if (
        not value
        or value != value.strip()
        or len(value.encode("utf-8")) > 200
        or any(not character.isprintable() for character in value)
    ):
        raise ValueError("idempotency_key must contain 1 to 200 visible characters without padding")
    return value


@dataclass(frozen=True, slots=True)
class CreditResult:
    outcome: Literal["charged", "refunded", "replayed", "epoch_expired"]
    balance: CreditAmount
    requested: CreditAmount = _ZERO_CREDIT_AMOUNT
    restored: CreditAmount = _ZERO_CREDIT_AMOUNT

    @property
    def balance_atoms(self) -> int:
        return self.balance.atoms

    @property
    def requested_atoms(self) -> int:
        return self.requested.atoms

    @property
    def restored_atoms(self) -> int:
        return self.restored.atoms


CreditInput = CreditAmount | Decimal | int | str


def _amount(value: CreditInput) -> CreditAmount:
    amount = value if isinstance(value, CreditAmount) else CreditAmount.parse(value)
    if amount.atoms == 0:
        raise ValueError("amount must be greater than zero")
    return amount


class CreditService:
    """Atomic FEFO consumption and source-safe product refund operations."""

    def __init__(self, pool: asyncpg.Pool) -> None:
        self.pool = pool

    @staticmethod
    async def _expire_account_pack_lots(
        conn: asyncpg.Connection,
        account_id: Any,
        *,
        as_of: datetime,
    ) -> bool:
        """Project lazy expiry and report whether pack funding has expired."""

        expired = await conn.fetchval(
            """with projected as (
                   update credit_funding_lots
                      set expired_credits=expired_credits+remaining_credits,
                          status='expired',remaining_credits=0,
                          closed_at=$2,updated_at=clock_timestamp()
                    where account_id=$1 and status='active' and expires_at <= $2
                    returning 1
                 )
                 select exists(select 1 from projected)
                     or exists(
                          select 1 from credit_funding_lots
                           where account_id=$1 and status='expired'
                        )""",
            account_id,
            as_of,
        )
        return bool(expired)

    async def charge(
        self, account_id: str, amount: CreditInput, idempotency_key: str
    ) -> CreditResult:
        normalized = _amount(amount)
        amount_atoms = normalized.atoms
        idempotency_key = _validate_idempotency_key(idempotency_key)
        async with self.pool.acquire() as conn, conn.transaction():
            account = await conn.fetchrow(
                "select * from billing_accounts where id=$1::uuid for update", account_id
            )
            if account is None:
                raise KeyError("account not found")
            database_now = await conn.fetchval("select clock_timestamp()")
            pack_window_expired = await self._expire_account_pack_lots(
                conn,
                account["id"],
                as_of=database_now,
            )
            lots = await conn.fetch(
                """select * from credit_funding_lots
                     where account_id=$1 and status='active' and expires_at > $2
                     order by expires_at,id for update""",
                account["id"],
                database_now,
            )
            claimed = await conn.fetchval(
                """insert into credit_debits(idempotency_key,account_id,amount,grant_epoch)
                     values($1,$2,$3,$4)
                     on conflict(idempotency_key) do nothing returning idempotency_key""",
                idempotency_key,
                account["id"],
                amount_atoms,
                account["grant_epoch"],
            )
            if claimed is None:
                existing = await conn.fetchrow(
                    "select * from credit_debits where idempotency_key=$1", idempotency_key
                )
                if existing is None:
                    raise RuntimeError("credit debit identity disappeared during conflict handling")
                if (
                    str(existing["account_id"]) != account_id
                    or int(existing["amount"]) != amount_atoms
                    or existing["kind"] != "usage"
                ):
                    raise ValueError("idempotency key was already used with different parameters")
                total = spendable_subscription_atoms(account, as_of=database_now) + sum(
                    int(lot["remaining_credits"]) for lot in lots
                )
                return CreditResult(
                    "replayed",
                    CreditAmount.from_atoms(total),
                    requested=normalized,
                    restored=CreditAmount.from_atoms(int(existing["restored_credits"])),
                )
            subscription_usable = subscription_credits_are_spendable(account, as_of=database_now)
            sources: list[tuple[datetime, str, Any, int]] = [
                (lot["expires_at"], "credit_pack", lot, int(lot["remaining_credits"]))
                for lot in lots
                if int(lot["remaining_credits"]) > 0
            ]
            if subscription_usable and int(account["credits_balance"]) > 0:
                sources.append(
                    (
                        account["credit_expires_at"],
                        "subscription",
                        account,
                        int(account["credits_balance"]),
                    )
                )
            sources.sort(key=lambda source: (source[0], source[1], str(source[2]["id"])))
            available = sum(source[3] for source in sources)
            if available < amount_atoms:
                if available == 0 and not lots and not subscription_usable:
                    if account["subscription_status"] != "active" and not pack_window_expired:
                        raise CreditsUnavailableError("subscription is not active")
                    if account["entitlement_revoked"] and not pack_window_expired:
                        raise CreditsUnavailableError("the paid entitlement was revoked")
                    raise CreditsUnavailableError("the paid credit window has expired")
                raise InsufficientCreditsError("insufficient credits")
            remaining = amount_atoms
            subscription_used = 0
            for _, source_type, source, source_available in sources:
                used = min(remaining, source_available)
                if used <= 0:
                    continue
                if source_type == "subscription":
                    subscription_used += used
                    await conn.execute(
                        """insert into credit_debit_allocations(
                               debit_idempotency_key,account_id,source_type,
                               subscription_grant_epoch,amount)
                             values($1,$2,'subscription',$3,$4)""",
                        idempotency_key,
                        account["id"],
                        account["grant_epoch"],
                        used,
                    )
                else:
                    await conn.execute(
                        """update credit_funding_lots
                              set remaining_credits=remaining_credits-$2,updated_at=now()
                            where id=$1 and remaining_credits >= $2""",
                        source["id"],
                        used,
                    )
                    await conn.execute(
                        """insert into credit_debit_allocations(
                               debit_idempotency_key,account_id,source_type,funding_lot_id,amount)
                             values($1,$2,'credit_pack',$3,$4)""",
                        idempotency_key,
                        account["id"],
                        source["id"],
                        used,
                    )
                remaining -= used
                if remaining == 0:
                    break
            if subscription_used:
                subscription_balance = int(account["credits_balance"]) - subscription_used
                await conn.execute(
                    """update billing_accounts set credits_balance=$2,updated_at=now()
                         where id=$1""",
                    account["id"],
                    subscription_balance,
                )
                await conn.execute(
                    """insert into credit_ledger
                         (account_id,delta,balance_after,reason,grant_epoch,stripe_event_id)
                       values($1,$2,$3,'usage_charge',$4,$5)""",
                    account["id"],
                    -subscription_used,
                    subscription_balance,
                    account["grant_epoch"],
                    f"usage:{idempotency_key}",
                )
            total = available - amount_atoms
            return CreditResult(
                "charged",
                CreditAmount.from_atoms(total),
                requested=normalized,
            )

    @staticmethod
    async def _return_subscription_atoms(
        conn: asyncpg.Connection,
        *,
        account: Mapping[str, Any],
        amount: int,
        event_id: str,
        reason: str,
        as_of: datetime,
    ) -> int:
        """Return current-epoch atoms, then settle existing funding liabilities."""

        usable = subscription_credits_are_spendable(account, as_of=as_of)
        if not usable:
            return 0
        current_balance = int(
            await conn.fetchval(
                "select credits_balance from billing_accounts where id=$1", account["id"]
            )
        )
        balance = checked_add_atoms(
            current_balance,
            amount,
            field="refunded subscription credit balance",
        )
        await conn.execute(
            "update billing_accounts set credits_balance=$2,updated_at=now() where id=$1",
            account["id"],
            balance,
        )
        await conn.execute(
            """insert into credit_ledger(
                   account_id,delta,balance_after,reason,grant_epoch,stripe_event_id)
                 values($1,$2,$3,$4,$5,$6)""",
            account["id"],
            amount,
            balance,
            reason,
            account["grant_epoch"],
            event_id,
        )
        await collect_clawback_debts(
            conn,
            account_id=account["id"],
            grant_epoch=int(account["grant_epoch"]),
            event_id=event_id,
        )
        await collect_pack_debts_from_subscription(
            conn,
            account_id=account["id"],
            grant_epoch=int(account["grant_epoch"]),
            event_id=event_id,
        )
        return amount

    async def _relieve_pack_debt(
        self,
        conn: asyncpg.Connection,
        *,
        account: Mapping[str, Any],
        order_id: Any,
        amount: int,
        visiting: set[str],
        as_of: datetime,
    ) -> tuple[int, int]:
        """Release uncollected debt first, then unwind collected source allocations."""

        debt = await conn.fetchrow(
            "select * from credit_pack_clawback_debts where order_id=$1 for update",
            order_id,
        )
        if debt is None or amount <= 0:
            return 0, 0
        if debt["account_id"] != account["id"]:
            raise RuntimeError("credit-pack clawback debt belongs to another account")
        active_debt = int(debt["target_credits"]) - int(debt["released_credits"])
        relief = min(amount, active_debt)
        if relief <= 0:
            return 0, 0

        uncollected = active_debt - int(debt["collected_credits"])
        release_uncollected = min(relief, uncollected)
        if release_uncollected:
            await conn.execute(
                """update credit_pack_clawback_debts
                      set released_credits=released_credits+$2,updated_at=now()
                    where order_id=$1""",
                order_id,
                release_uncollected,
            )

        reverse_collected = relief - release_uncollected
        if reverse_collected <= 0:
            return relief, 0
        collections = await conn.fetch(
            """select d.idempotency_key,d.account_id as debit_account_id,
                      d.amount as debit_amount,
                      d.restored_credits,d.created_at,
                      a.id as allocation_id,a.account_id as allocation_account_id,
                      a.source_type,
                      a.subscription_grant_epoch,a.funding_lot_id,
                      a.amount as allocation_amount,a.refunded_amount
                 from credit_debits d
                 join credit_debit_allocations a
                   on a.debit_idempotency_key=d.idempotency_key
                where d.kind='credit_pack_debt_collection'
                  and d.clawback_order_id=$1
                  and a.refunded_amount < a.amount
                order by d.created_at,d.idempotency_key,a.id
                for update of d,a""",
            order_id,
        )
        remaining = reverse_collected
        recovered = 0
        for collection in collections:
            if remaining <= 0:
                break
            collection_key = str(collection["idempotency_key"])
            if collection_key in visiting:
                raise RuntimeError("credit-pack debt collection cycle detected")
            if (
                collection["debit_account_id"] != account["id"]
                or collection["allocation_account_id"] != account["id"]
            ):
                raise RuntimeError("credit-pack debt collection belongs to another account")
            if int(collection["debit_amount"]) != int(collection["allocation_amount"]):
                raise RuntimeError("credit-pack debt collection allocation is inconsistent")
            pending = int(collection["allocation_amount"]) - int(collection["refunded_amount"])
            reversing = min(remaining, pending)
            if reversing <= 0:
                continue
            await conn.execute(
                """update credit_pack_clawback_debts
                      set collected_credits=collected_credits-$2,
                          released_credits=released_credits+$2,updated_at=now()
                    where order_id=$1 and collected_credits >= $2""",
                order_id,
                reversing,
            )
            visiting.add(collection_key)
            try:
                restored = await self._restore_allocation_effect(
                    conn,
                    account=account,
                    allocation=collection,
                    amount=reversing,
                    event_id=f"pack-debt-release:{collection_key}",
                    reason="credit_pack_debt_refund",
                    visiting=visiting,
                    as_of=as_of,
                )
            finally:
                visiting.remove(collection_key)
            new_restored = checked_add_atoms(
                int(collection["restored_credits"]),
                restored,
                field="debt-collection restored credits",
            )
            await conn.execute(
                """update credit_debit_allocations
                      set refunded_amount=refunded_amount+$2,updated_at=now()
                    where id=$1 and refunded_amount+$2 <= amount""",
                collection["allocation_id"],
                reversing,
            )
            await conn.execute(
                """update credit_debits d set restored_credits=$2,
                       refunded_at=case
                         when not exists(
                           select 1 from credit_debit_allocations a
                            where a.debit_idempotency_key=d.idempotency_key
                              and a.refunded_amount < a.amount
                         ) then now() else refunded_at end
                     where d.idempotency_key=$1""",
                collection_key,
                new_restored,
            )
            recovered += restored
            remaining -= reversing
        if remaining:
            raise RuntimeError("credit-pack debt has no reversible funding allocation")
        return relief, recovered

    async def _restore_allocation_effect(
        self,
        conn: asyncpg.Connection,
        *,
        account: Mapping[str, Any],
        allocation: Mapping[str, Any],
        amount: int,
        event_id: str,
        reason: str,
        visiting: set[str],
        as_of: datetime,
    ) -> int:
        """Reverse one allocation without changing its refund progress marker."""

        if allocation["source_type"] == "subscription":
            if int(allocation["subscription_grant_epoch"]) != int(account["grant_epoch"]):
                return 0
            return await self._return_subscription_atoms(
                conn,
                account=account,
                amount=amount,
                event_id=event_id,
                reason=reason,
                as_of=as_of,
            )

        lot = await conn.fetchrow(
            "select * from credit_funding_lots where id=$1 for update",
            allocation["funding_lot_id"],
        )
        if lot is None or lot["account_id"] != account["id"]:
            raise RuntimeError("credit-pack allocation funding lot is missing or conflicting")
        if lot["status"] == "active" and lot["expires_at"] <= as_of:
            await conn.execute(
                """update credit_funding_lots
                      set expired_credits=expired_credits+remaining_credits,
                          status='expired',remaining_credits=0,
                          closed_at=$2,updated_at=clock_timestamp()
                    where id=$1""",
                lot["id"],
                as_of,
            )
            lot = await conn.fetchrow(
                "select * from credit_funding_lots where id=$1 for update", lot["id"]
            )
            assert lot is not None
        order = await conn.fetchrow(
            "select * from credit_pack_orders where id=$1 for update", lot["order_id"]
        )
        if order is None or order["account_id"] != account["id"]:
            raise RuntimeError("credit-pack allocation order is missing or conflicting")

        relieved, recovered = await self._relieve_pack_debt(
            conn,
            account=account,
            order_id=order["id"],
            amount=amount,
            visiting=visiting,
            as_of=as_of,
        )
        restorable = amount - relieved
        returned = 0
        if restorable and lot["status"] == "active":
            headroom = (
                int(order["pack_credits"])
                - int(order["refunded_credits"])
                - int(lot["remaining_credits"])
            )
            returned = min(restorable, max(headroom, 0))
            if returned:
                checked_add_atoms(
                    int(lot["remaining_credits"]),
                    returned,
                    field="refunded credit-pack lot balance",
                )
                await conn.execute(
                    """update credit_funding_lots
                          set remaining_credits=remaining_credits+$2,updated_at=now()
                        where id=$1""",
                    lot["id"],
                    returned,
                )
                await collect_pack_debts_from_lot(
                    conn,
                    account_id=account["id"],
                    lot_id=lot["id"],
                    available_atoms=returned,
                )
        elif restorable and lot["status"] == "expired":
            # The product operation was reversed, but its original funding window
            # has closed. Retire the would-have-been return as expired so a later
            # cash refund cannot mistake those atoms for still-consumed value and
            # create phantom cross-epoch debt.
            expired_headroom = (
                int(order["pack_credits"])
                - int(order["refunded_credits"])
                - int(lot["expired_credits"])
            )
            retired = min(restorable, max(expired_headroom, 0))
            if retired:
                checked_add_atoms(
                    int(lot["expired_credits"]),
                    retired,
                    field="expired product-refund credits",
                )
                await conn.execute(
                    """update credit_funding_lots
                          set expired_credits=expired_credits+$2,updated_at=now()
                        where id=$1""",
                    lot["id"],
                    retired,
                )
        return recovered + returned

    async def refund(
        self,
        idempotency_key: str,
        *,
        expected_account_id: str | None = None,
    ) -> CreditResult:
        idempotency_key = _validate_idempotency_key(idempotency_key)
        if expected_account_id is not None:
            try:
                expected_account_id = str(UUID(expected_account_id))
            except (AttributeError, TypeError, ValueError) as exc:
                raise ValueError("expected_account_id must be a UUID string") from exc
        async with self.pool.acquire() as conn, conn.transaction():
            account_id: object
            if expected_account_id is None:
                snapshot = await conn.fetchrow(
                    "select account_id from credit_debits where idempotency_key=$1",
                    idempotency_key,
                )
                if snapshot is None:
                    raise KeyError("credit debit not found")
                account_id = snapshot["account_id"]
            else:
                account_id = expected_account_id
            account = await conn.fetchrow(
                "select * from billing_accounts where id=$1::uuid for update", account_id
            )
            if account is None:
                raise KeyError("billing account not found")
            database_now = await conn.fetchval("select clock_timestamp()")
            await self._expire_account_pack_lots(
                conn,
                account["id"],
                as_of=database_now,
            )
            debit = await conn.fetchrow(
                "select * from credit_debits where idempotency_key=$1 for update", idempotency_key
            )
            if debit is None:
                raise KeyError("credit debit not found")
            if str(debit["account_id"]) != str(account["id"]):
                raise CreditDebitOwnerMismatchError("credit debit belongs to another account")
            if debit["kind"] != "usage":
                raise KeyError("credit debit is not a refundable product operation")

            requested = CreditAmount.from_atoms(int(debit["amount"]))
            if debit["refunded_at"] is not None:
                total = spendable_subscription_atoms(
                    account, as_of=database_now
                ) + await pack_balance_atoms(
                    conn,
                    account["id"],
                    lock=True,
                    as_of=database_now,
                )
                return CreditResult(
                    "replayed",
                    CreditAmount.from_atoms(total),
                    requested=requested,
                    restored=CreditAmount.from_atoms(int(debit["restored_credits"])),
                )

            allocations = await conn.fetch(
                """select * from credit_debit_allocations
                     where debit_idempotency_key=$1 order by id for update""",
                idempotency_key,
            )
            restored_atoms = 0
            if not allocations:
                # Compatibility for a pre-release subscription-only debit. New rows
                # always have an allocation and therefore use the source-safe path.
                if int(debit["grant_epoch"]) == int(account["grant_epoch"]):
                    restored_atoms = await self._return_subscription_atoms(
                        conn,
                        account=account,
                        amount=int(debit["amount"]),
                        event_id=f"usage-refund:{idempotency_key}",
                        reason="usage_refund",
                        as_of=database_now,
                    )
            else:
                visiting = {idempotency_key}
                for allocation in allocations:
                    pending = int(allocation["amount"]) - int(allocation["refunded_amount"])
                    if pending <= 0:
                        continue
                    restored_atoms += await self._restore_allocation_effect(
                        conn,
                        account=account,
                        allocation=allocation,
                        amount=pending,
                        event_id=f"usage-refund:{idempotency_key}",
                        reason="usage_refund",
                        visiting=visiting,
                        as_of=database_now,
                    )
                    await conn.execute(
                        """update credit_debit_allocations
                              set refunded_amount=refunded_amount+$2,updated_at=now()
                            where id=$1 and refunded_amount+$2 <= amount""",
                        allocation["id"],
                        pending,
                    )

            persisted_restored = checked_add_atoms(
                int(debit["restored_credits"]),
                restored_atoms,
                field="product-operation restored credits",
            )
            if persisted_restored > int(debit["amount"]):
                raise RuntimeError("restored credits exceed the original product debit")
            await conn.execute(
                """update credit_debits set restored_credits=$2,refunded_at=now()
                     where idempotency_key=$1""",
                idempotency_key,
                persisted_restored,
            )
            refreshed = await conn.fetchrow(
                "select * from billing_accounts where id=$1", account["id"]
            )
            assert refreshed is not None
            total = spendable_subscription_atoms(
                refreshed, as_of=database_now
            ) + await pack_balance_atoms(
                conn,
                account["id"],
                lock=True,
                as_of=database_now,
            )
            restored = CreditAmount.from_atoms(persisted_restored)
            return CreditResult(
                "refunded" if restored_atoms else "epoch_expired",
                CreditAmount.from_atoms(total),
                requested=requested,
                restored=restored,
            )
