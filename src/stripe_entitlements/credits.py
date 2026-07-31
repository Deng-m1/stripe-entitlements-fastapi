from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

import asyncpg


class InsufficientCreditsError(RuntimeError):
    pass


class CreditsUnavailableError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class CreditResult:
    outcome: Literal["charged", "refunded", "replayed", "epoch_expired"]
    balance: int


class CreditService:
    """Atomic credit consumption and epoch-safe refund operations."""

    def __init__(self, pool: asyncpg.Pool) -> None:
        self.pool = pool

    async def charge(self, account_id: str, amount: int, idempotency_key: str) -> CreditResult:
        if amount <= 0:
            raise ValueError("amount must be positive")
        if not idempotency_key:
            raise ValueError("idempotency_key is required")
        async with self.pool.acquire() as conn, conn.transaction():
            account = await conn.fetchrow(
                "select * from billing_accounts where id=$1::uuid for update", account_id
            )
            if account is None:
                raise KeyError("account not found")
            existing = await conn.fetchrow(
                "select * from credit_debits where idempotency_key=$1", idempotency_key
            )
            if existing is not None:
                if str(existing["account_id"]) != account_id or int(existing["amount"]) != amount:
                    raise ValueError("idempotency key was already used with different parameters")
                return CreditResult("replayed", int(account["credits_balance"]))
            if account["subscription_status"] != "active":
                raise CreditsUnavailableError("subscription is not active")
            if account["entitlement_revoked"]:
                raise CreditsUnavailableError("the paid entitlement was revoked")
            if account["credit_expires_at"] is None or not await conn.fetchval(
                "select $1::timestamptz > now()", account["credit_expires_at"]
            ):
                raise CreditsUnavailableError("the paid credit window has expired")
            if int(account["credits_balance"]) < amount:
                raise InsufficientCreditsError("insufficient credits")
            balance = int(account["credits_balance"]) - amount
            await conn.execute(
                "update billing_accounts set credits_balance=$2,updated_at=now() where id=$1",
                account["id"],
                balance,
            )
            await conn.execute(
                """insert into credit_debits(idempotency_key,account_id,amount,grant_epoch)
                     values($1,$2,$3,$4)""",
                idempotency_key,
                account["id"],
                amount,
                account["grant_epoch"],
            )
            await conn.execute(
                """insert into credit_ledger
                     (account_id,delta,balance_after,reason,grant_epoch,stripe_event_id)
                   values($1,$2,$3,'usage_charge',$4,$5)""",
                account["id"],
                -amount,
                balance,
                account["grant_epoch"],
                f"usage:{idempotency_key}",
            )
            return CreditResult("charged", balance)

    async def refund(self, idempotency_key: str) -> CreditResult:
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
                return CreditResult("replayed", int(account["credits_balance"]))
            if int(debit["grant_epoch"]) != int(account["grant_epoch"]):
                return CreditResult("epoch_expired", int(account["credits_balance"]))
            balance = int(account["credits_balance"]) + int(debit["amount"])
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
            return CreditResult("refunded", balance)
