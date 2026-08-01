from __future__ import annotations

from typing import Any

import asyncpg


async def collect_clawback_debts(
    conn: asyncpg.Connection,
    *,
    account_id: Any,
    grant_epoch: int,
    event_id: str,
) -> int:
    """Consume newly returned credits against current-epoch funding debt.

    The caller and this helper use the global account-before-debt lock order. Credits
    must already be present in the account balance so the ledger records the complete
    positive grant/refund followed by each deterministic debt collection.
    """
    account = await conn.fetchrow(
        "select credits_balance from billing_accounts where id=$1 for update",
        account_id,
    )
    if account is None:
        raise KeyError("account not found")
    balance = int(account["credits_balance"])
    debts = await conn.fetch(
        """select * from billing_clawback_debts
             where account_id=$1 and grant_epoch=$2
               and collected_units < target_units
             order by created_at,stripe_invoice_id for update""",
        account_id,
        grant_epoch,
    )
    collected = 0
    for debt in debts:
        outstanding = int(debt["target_units"]) - int(debt["collected_units"])
        amount = min(outstanding, balance)
        if amount <= 0:
            break
        balance -= amount
        collected += amount
        await conn.execute(
            """update billing_clawback_debts set
                   collected_units=collected_units+$4,updated_at=now()
                 where account_id=$1 and grant_epoch=$2 and stripe_invoice_id=$3""",
            account_id,
            grant_epoch,
            debt["stripe_invoice_id"],
            amount,
        )
        await conn.execute(
            """insert into credit_ledger(
                   account_id,delta,balance_after,reason,grant_epoch,
                   stripe_event_id,stripe_invoice_id)
                 values($1,$2,$3,'clawback_debt_collection',$4,$5,$6)""",
            account_id,
            -amount,
            balance,
            grant_epoch,
            event_id,
            debt["stripe_invoice_id"],
        )
    if collected:
        await conn.execute(
            "update billing_accounts set credits_balance=$2,updated_at=now() where id=$1",
            account_id,
            balance,
        )
    return collected
