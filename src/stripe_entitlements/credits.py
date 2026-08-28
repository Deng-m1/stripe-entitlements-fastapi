from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Literal

import asyncpg

from .clawbacks import collect_clawback_debts
from .credit_amount import CreditAmount, checked_add_atoms


class InsufficientCreditsError(RuntimeError):
    pass


class CreditsUnavailableError(RuntimeError):
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

    @property
    def balance_atoms(self) -> int:
        return self.balance.atoms


CreditInput = CreditAmount | Decimal | int | str


def _amount(value: CreditInput) -> CreditAmount:
    amount = value if isinstance(value, CreditAmount) else CreditAmount.parse(value)
    if amount.atoms == 0:
        raise ValueError("amount must be greater than zero")
    return amount


class CreditService:
    """Atomic credit consumption and epoch-safe refund operations."""

    def __init__(self, pool: asyncpg.Pool) -> None:
        self.pool = pool

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
                ):
                    raise ValueError("idempotency key was already used with different parameters")
                return CreditResult(
                    "replayed", CreditAmount.from_atoms(int(account["credits_balance"]))
                )
            if account["subscription_status"] != "active":
                raise CreditsUnavailableError("subscription is not active")
            if account["entitlement_revoked"]:
                raise CreditsUnavailableError("the paid entitlement was revoked")
            if account["credit_expires_at"] is None or not await conn.fetchval(
                "select $1::timestamptz > now()", account["credit_expires_at"]
            ):
                raise CreditsUnavailableError("the paid credit window has expired")
            if int(account["credits_balance"]) < amount_atoms:
                raise InsufficientCreditsError("insufficient credits")
            balance = int(account["credits_balance"]) - amount_atoms
            await conn.execute(
                "update billing_accounts set credits_balance=$2,updated_at=now() where id=$1",
                account["id"],
                balance,
            )
            await conn.execute(
                """insert into credit_ledger
                     (account_id,delta,balance_after,reason,grant_epoch,stripe_event_id)
                   values($1,$2,$3,'usage_charge',$4,$5)""",
                account["id"],
                -amount_atoms,
                balance,
                account["grant_epoch"],
                f"usage:{idempotency_key}",
            )
            return CreditResult("charged", CreditAmount.from_atoms(balance))

    async def refund(self, idempotency_key: str) -> CreditResult:
        idempotency_key = _validate_idempotency_key(idempotency_key)
        async with self.pool.acquire() as conn, conn.transaction():
            snapshot = await conn.fetchrow(
                "select account_id from credit_debits where idempotency_key=$1", idempotency_key
            )
            if snapshot is None:
                raise KeyError("credit debit not found")
            account = await conn.fetchrow(
                "select * from billing_accounts where id=$1 for update", snapshot["account_id"]
            )
            assert account is not None
            debit = await conn.fetchrow(
                "select * from credit_debits where idempotency_key=$1 for update", idempotency_key
            )
            assert debit is not None
            if debit["refunded_at"] is not None:
                return CreditResult(
                    "replayed", CreditAmount.from_atoms(int(account["credits_balance"]))
                )
            if int(debit["grant_epoch"]) != int(account["grant_epoch"]):
                return CreditResult(
                    "epoch_expired", CreditAmount.from_atoms(int(account["credits_balance"]))
                )
            balance = checked_add_atoms(
                int(account["credits_balance"]),
                int(debit["amount"]),
                field="refunded credit balance",
            )
            await conn.execute(
                "update billing_accounts set credits_balance=$2,updated_at=now() where id=$1",
                account["id"],
                balance,
            )
            await conn.execute(
                "update credit_debits set refunded_at=now() where idempotency_key=$1",
                idempotency_key,
            )
            await conn.execute(
                """insert into credit_ledger
                     (account_id,delta,balance_after,reason,grant_epoch,stripe_event_id)
                   values($1,$2,$3,'usage_refund',$4,$5)""",
                account["id"],
                debit["amount"],
                balance,
                account["grant_epoch"],
                f"usage-refund:{idempotency_key}",
            )
            await collect_clawback_debts(
                conn,
                account_id=account["id"],
                grant_epoch=int(account["grant_epoch"]),
                event_id=f"usage-refund:{idempotency_key}",
            )
            final_balance = int(
                await conn.fetchval(
                    "select credits_balance from billing_accounts where id=$1",
                    account["id"],
                )
                or 0
            )
            return CreditResult("refunded", CreditAmount.from_atoms(final_balance))
