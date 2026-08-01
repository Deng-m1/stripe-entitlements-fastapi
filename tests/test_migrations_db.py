from __future__ import annotations

import uuid
from pathlib import Path

import asyncpg

ROOT = Path(__file__).parents[1]


async def test_transition_policy_migration_backfills_only_applied_closures(
    pool: asyncpg.Pool,
) -> None:
    schema = f"migration_backfill_{uuid.uuid4().hex}"
    account_id = uuid.uuid4()
    async with pool.acquire() as conn, conn.transaction():
        await conn.execute(f'create schema "{schema}"')
        await conn.execute(f'set local search_path to "{schema}", public')
        await conn.execute((ROOT / "migrations/001_schema.sql").read_text())
        await conn.execute((ROOT / "migrations/002_plan_transitions.sql").read_text())
        await conn.execute(
            "insert into billing_accounts(id,external_ref) values($1,'migration-user')",
            account_id,
        )
        await conn.executemany(
            """insert into stripe_invoice_state(
                   invoice_id,account_id,amount_total,amount_refunded,fully_refunded)
                 values($1,$2,100,$3,$4)""",
            [
                ("in_closure_was_applied", account_id, 100, True),
                ("in_refund_arrived_before_paid", account_id, 100, True),
                ("in_near_full_blocked", account_id, 99, False),
                ("in_partial_with_normal_grant", account_id, 50, False),
            ],
        )
        await conn.executemany(
            """insert into credit_ledger(
                   account_id,delta,balance_after,entitlement_units,reason,grant_epoch,
                   stripe_invoice_id,grant_slot)
                 values($1,0,0,$2,$3,1,$4,1)""",
            [
                (account_id, 300, "subscription_grant", "in_closure_was_applied"),
                (account_id, 0, "subscription_grant_blocked", "in_near_full_blocked"),
                (account_id, 300, "subscription_grant", "in_partial_with_normal_grant"),
            ],
        )

        await conn.execute((ROOT / "migrations/003_transition_policies.sql").read_text())

        rows = await conn.fetch(
            "select invoice_id,closure_applied from stripe_invoice_state order by invoice_id"
        )
    assert [tuple(row) for row in rows] == [
        ("in_closure_was_applied", True),
        ("in_near_full_blocked", True),
        ("in_partial_with_normal_grant", False),
        ("in_refund_arrived_before_paid", False),
    ]
