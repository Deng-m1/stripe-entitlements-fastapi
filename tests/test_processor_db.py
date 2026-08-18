from __future__ import annotations

import uuid
from typing import Any

import asyncpg
import pytest

from stripe_entitlements.bounds import POSTGRES_BIGINT_MAX
from stripe_entitlements.credits import CreditService
from stripe_entitlements.event_audit import event_payload_sha256
from stripe_entitlements.processor import EventProcessor
from tests.builders import (
    checkout_event,
    dispute,
    event,
    paid_invoice,
    payment_failed,
    refunded_charge,
    subscription_event,
)


@pytest.mark.parametrize("drift", ["amount", "quantity", "currency"])
async def test_catalog_amount_currency_and_quantity_drift_fail_closed(
    drift: str, processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    payload = paid_invoice(account_id, invoice_id=f"in_drift_{drift}")
    invoice = payload["data"]["object"]
    line = invoice["lines"]["data"][0]
    if drift == "amount":
        line["amount"] = invoice["amount_paid"] = invoice["total"] = 1
    elif drift == "quantity":
        line["quantity"] = 2
    else:
        line["currency"] = invoice["currency"] = "eur"

    result = await processor.process(payload)
    assert result.outcome == "ignored"
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "select credits_balance from billing_accounts where id=$1::uuid", account_id
        )
    assert row is not None and row["credits_balance"] == 0


@pytest.mark.parametrize(
    "drift",
    [
        "price_id",
        "lookup_key",
        "product_line",
        "product_plan",
        "interval_count",
        "unit_amount",
    ],
)
async def test_paid_invoice_price_and_product_identity_drift_fail_closed(
    drift: str, processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    payload = paid_invoice(account_id, invoice_id=f"in_price_identity_{drift}")
    resolved = payload["data"]["object"]["lines"]["data"][0]["_resolved_price"]
    if drift == "price_id":
        resolved["id"] = "price_other"
    elif drift == "lookup_key":
        resolved["lookup_key"] = "ent_ultra_month"
    elif drift == "product_line":
        resolved["product"]["metadata"]["product_line"] = "other-product"
    elif drift == "product_plan":
        resolved["product"]["metadata"]["plan"] = "ultra"
    elif drift == "interval_count":
        resolved["recurring"]["interval_count"] = 2
    else:
        resolved["unit_amount"] = 1

    result = await processor.process(payload)
    assert result.outcome == "ignored"
    assert result.reason == "Invoice Price or Product identity does not match the catalog"
    async with pool.acquire() as conn:
        balance = await conn.fetchval(
            "select credits_balance from billing_accounts where id=$1::uuid", account_id
        )
        incident = await conn.fetchval(
            """select count(*) from billing_incidents
                 where kind='invoice_price_identity_mismatch'"""
        )
    assert balance == 0
    assert incident == 1


async def test_paid_invoice_allows_legacy_missing_product_line_when_price_identity_matches(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    payload = paid_invoice(account_id, invoice_id="in_legacy_missing_product_line")
    metadata = payload["data"]["object"]["parent"]["subscription_details"]["metadata"]
    metadata.pop("product_line")

    result = await processor.process(payload)
    async with pool.acquire() as conn:
        balance = await conn.fetchval(
            "select credits_balance from billing_accounts where id=$1::uuid", account_id
        )
        incident = await conn.fetchval(
            "select count(*) from billing_incidents where kind='product_line_identity_conflict'"
        )
    assert result.outcome == "handled"
    assert balance == 300
    assert incident == 0


async def test_paid_invoice_rejects_conflicting_product_line(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    payload = paid_invoice(account_id, invoice_id="in_conflicting_product_line")
    metadata = payload["data"]["object"]["parent"]["subscription_details"]["metadata"]
    metadata["product_line"] = "other-product"

    result = await processor.process(payload)
    async with pool.acquire() as conn:
        balance = await conn.fetchval(
            "select credits_balance from billing_accounts where id=$1::uuid", account_id
        )
        incident = await conn.fetchval(
            "select count(*) from billing_incidents where kind='product_line_identity_conflict'"
        )
    assert result.outcome == "ignored"
    assert balance == 0
    assert incident == 1


@pytest.mark.parametrize("customer", [None, 123, " padded ", "zero\u200bwidth"])
async def test_paid_invoice_requires_customer_identity(
    customer: object, processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    payload = paid_invoice(account_id, invoice_id=f"in_invalid_customer_{customer}")
    payload["data"]["object"]["customer"] = customer

    result = await processor.process(payload)
    async with pool.acquire() as conn:
        balance = await conn.fetchval(
            "select credits_balance from billing_accounts where id=$1::uuid", account_id
        )
        incident = await conn.fetchval(
            "select count(*) from billing_incidents where kind='paid_customer_identity_conflict'"
        )
    assert result.outcome == "ignored"
    assert balance == 0
    assert incident == 1


async def test_paid_invoice_can_use_an_archived_but_still_identified_price(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    payload = paid_invoice(account_id, invoice_id="in_archived_catalog_price")
    resolved = payload["data"]["object"]["lines"]["data"][0]["_resolved_price"]
    resolved["active"] = False
    resolved["product"]["active"] = False

    result = await processor.process(payload)
    assert result.outcome == "handled"
    assert (await _account(pool, account_id))["credits_balance"] == 300


@pytest.mark.parametrize(
    ("malformation", "incident_kind"),
    [
        ("lines_not_object", "incomplete_invoice_lines"),
        ("line_data_not_array", "invalid_invoice_line_shape"),
        ("line_not_object", "invalid_invoice_line_shape"),
        ("line_id_missing", "invalid_invoice_line_shape"),
        ("line_id_duplicate", "invalid_invoice_line_shape"),
        ("line_amount_not_integer", "invalid_invoice_line_shape"),
        ("invoice_total_not_integer", "invoice_catalog_amount_mismatch"),
        ("quantity_not_integer", "invoice_catalog_amount_mismatch"),
        ("period_not_object", "invalid_entitlement_period"),
        ("balance_not_integer", "invoice_catalog_amount_mismatch"),
    ],
)
async def test_malformed_invoice_field_types_fail_closed_without_retry_loop(
    malformation: str,
    incident_kind: str,
    processor: EventProcessor,
    pool: asyncpg.Pool,
    make_account,
) -> None:
    account_id = await make_account()
    payload = paid_invoice(account_id, invoice_id=f"in_type_{malformation}")
    invoice = payload["data"]["object"]
    line = invoice["lines"]["data"][0]
    if malformation == "lines_not_object":
        invoice["lines"] = "invalid"
    elif malformation == "line_data_not_array":
        invoice["lines"]["data"] = "invalid"
    elif malformation == "line_not_object":
        invoice["lines"]["data"] = ["invalid"]
    elif malformation == "line_id_missing":
        line["id"] = None
    elif malformation == "line_id_duplicate":
        invoice["lines"]["data"].append(dict(line))
    elif malformation == "line_amount_not_integer":
        line["amount"] = "1900"
    elif malformation == "invoice_total_not_integer":
        invoice["total"] = "1900"
    elif malformation == "quantity_not_integer":
        line["quantity"] = "1"
    elif malformation == "period_not_object":
        line["period"] = [1_800_000_000, 1_802_592_000]
    else:
        invoice["starting_balance"] = "0"

    result = await processor.process(payload)
    duplicate = await processor.process(payload)
    async with pool.acquire() as conn:
        balance = await conn.fetchval(
            "select credits_balance from billing_accounts where id=$1::uuid", account_id
        )
        incident = await conn.fetchval(
            "select count(*) from billing_incidents where kind=$1",
            incident_kind,
        )
        inbox = await conn.fetchrow(
            "select outcome,processed_at from stripe_webhook_events where id=$1",
            payload["id"],
        )
    assert result.outcome == "ignored"
    assert duplicate.outcome == "duplicate"
    assert balance == 0
    assert incident == 1
    assert inbox is not None and inbox["outcome"] == "ignored"
    assert inbox["processed_at"] is not None


async def test_invoice_preparation_failure_is_durable_and_does_not_retry_forever(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    payload = paid_invoice(account_id, invoice_id="in_preparation_failure")
    invoice = payload["data"]["object"]
    invoice["_preparation_error"] = "Stripe Invoice line pagination contains duplicate identity"
    invoice["lines"]["has_more"] = True

    result = await processor.process(payload)
    duplicate = await processor.process(payload)
    async with pool.acquire() as conn:
        balance = await conn.fetchval(
            "select credits_balance from billing_accounts where id=$1::uuid", account_id
        )
        incident = await conn.fetchrow(
            """select detail,seen_count from billing_incidents
                 where kind='invoice_preparation_failed'"""
        )
        inbox = await conn.fetchrow(
            "select outcome,processed_at from stripe_webhook_events where id=$1",
            payload["id"],
        )
    assert result.outcome == "ignored"
    assert duplicate.outcome == "duplicate"
    assert balance == 0
    assert incident is not None
    assert incident["detail"]["reason"] == invoice["_preparation_error"]
    assert incident["seen_count"] == 1
    assert inbox is not None and inbox["outcome"] == "ignored"
    assert inbox["processed_at"] is not None


@pytest.mark.parametrize(
    "adjustment",
    [
        "amount_due",
        "subtotal",
        "balance",
        "credit_note",
        "tax",
        "zero_tax",
        "discount",
        "zero_discount",
        "automatic_tax",
        "malformed_automatic_tax",
        "malformed_tax_collection",
        "singular_discount",
    ],
)
async def test_full_period_paid_invoice_adjustments_fail_closed(
    adjustment: str, processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    payload = paid_invoice(account_id, invoice_id=f"in_full_adjustment_{adjustment}")
    invoice = payload["data"]["object"]
    if adjustment == "amount_due":
        invoice["amount_due"] = 1800
    elif adjustment == "subtotal":
        invoice["subtotal"] = 1800
    elif adjustment == "balance":
        invoice["starting_balance"] = -100
    elif adjustment == "credit_note":
        invoice["pre_payment_credit_notes_amount"] = 100
    elif adjustment == "tax":
        invoice["lines"]["data"][0]["tax_amounts"] = [{"amount": 100}]
    elif adjustment == "zero_tax":
        invoice["lines"]["data"][0]["tax_amounts"] = [{"amount": 0}]
    elif adjustment == "discount":
        invoice["total_discount_amounts"] = [{"amount": 100}]
    elif adjustment == "zero_discount":
        invoice["lines"]["data"][0]["discount_amounts"] = [{"amount": 0}]
    elif adjustment == "automatic_tax":
        invoice["automatic_tax"] = {"enabled": True}
    elif adjustment == "malformed_automatic_tax":
        invoice["automatic_tax"] = {}
    elif adjustment == "malformed_tax_collection":
        invoice["total_tax_amounts"] = {}
    else:
        invoice["discount"] = {}

    result = await processor.process(payload)
    assert result.outcome == "ignored"
    assert (await _account(pool, account_id))["credits_balance"] == 0


@pytest.mark.parametrize(
    "payment_shape",
    [
        "gateway_marker",
        "pagination",
        "multiple",
        "payment_record",
        "out_of_band",
        "overpaid",
    ],
)
async def test_unsupported_invoice_payment_shapes_fail_closed(
    payment_shape: str, processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    payload = paid_invoice(account_id, invoice_id=f"in_payment_shape_{payment_shape}")
    invoice = payload["data"]["object"]
    paid_payment = {
        "id": "inpay_primary",
        "status": "paid",
        "payment": {"type": "payment_intent", "payment_intent": "pi_primary"},
    }
    if payment_shape == "gateway_marker":
        invoice["_unsupported_invoice_payment_shape"] = True
    elif payment_shape == "pagination":
        invoice["payments"] = {"data": [paid_payment], "has_more": True}
    elif payment_shape == "multiple":
        invoice["payments"] = {
            "data": [
                paid_payment,
                {
                    "id": "inpay_secondary",
                    "status": "paid",
                    "payment": {
                        "type": "payment_intent",
                        "payment_intent": "pi_secondary",
                    },
                },
            ],
            "has_more": False,
        }
    elif payment_shape == "payment_record":
        invoice["payments"] = {
            "data": [
                {
                    "id": "inpay_record",
                    "status": "paid",
                    "payment": {"type": "payment_record", "payment_record": "pyr_test"},
                }
            ],
            "has_more": False,
        }
    elif payment_shape == "out_of_band":
        invoice["paid_out_of_band"] = True
    else:
        invoice["amount_overpaid"] = 1

    result = await processor.process(payload)
    assert result.outcome == "ignored"
    assert (await _account(pool, account_id))["credits_balance"] == 0
    async with pool.acquire() as conn:
        assert (
            await conn.fetchval(
                """select count(*) from billing_incidents
                     where kind='unsupported_invoice_payment_shape'"""
            )
            == 1
        )


async def test_single_paid_invoice_payment_shape_is_supported(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    payload = paid_invoice(account_id, invoice_id="in_single_payment_shape")
    payload["data"]["object"]["payments"] = {
        "data": [
            {
                "id": "inpay_single",
                "status": "paid",
                "payment": {"type": "payment_intent", "payment_intent": "pi_single"},
            }
        ],
        "has_more": False,
    }
    assert (await processor.process(payload)).outcome == "handled"
    assert (await _account(pool, account_id))["credits_balance"] == 300


async def test_incomplete_invoice_line_page_fails_closed(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    payload = paid_invoice(account_id, invoice_id="in_incomplete_lines")
    payload["data"]["object"]["lines"]["has_more"] = True
    result = await processor.process(payload)
    assert result.outcome == "ignored"
    assert result.reason == "Invoice line pagination is incomplete"
    assert (await _account(pool, account_id))["credits_balance"] == 0


async def _account(pool: asyncpg.Pool, account_id: str) -> dict[str, Any]:
    async with pool.acquire() as conn:
        row = await conn.fetchrow("select * from billing_accounts where id=$1::uuid", account_id)
    assert row is not None
    return dict(row)


async def _ledger(pool: asyncpg.Pool, account_id: str) -> list[dict[str, Any]]:
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "select * from credit_ledger where account_id=$1::uuid order by id", account_id
        )
    return [dict(row) for row in rows]


@pytest.mark.parametrize(
    ("mismatch", "expected_reason"),
    [
        ("livemode", "event livemode does not match the configured Stripe key mode"),
        ("api_version", "event API version does not match the pinned webhook endpoint"),
    ],
)
async def test_webhook_contract_mismatch_is_durable_and_has_no_business_effect(
    mismatch: str,
    expected_reason: str,
    processor: EventProcessor,
    pool: asyncpg.Pool,
    make_account,
) -> None:
    account_id = await make_account(customer=None, subscription=None)
    payload = paid_invoice(
        account_id,
        invoice_id=f"in_contract_{mismatch}",
        event_id=f"evt_contract_{mismatch}",
    )
    if mismatch == "livemode":
        payload["livemode"] = True
    else:
        payload["api_version"] = "2025-12-15.clover"

    result = await processor.process(payload)
    duplicate = await processor.process(payload)

    assert (result.outcome, result.reason) == ("ignored", expected_reason)
    assert duplicate.outcome == "duplicate"
    async with pool.acquire() as conn:
        account = await conn.fetchrow(
            """select plan_key,plan_interval,subscription_status,credits_balance
                 from billing_accounts where id=$1::uuid""",
            account_id,
        )
        inbox = await conn.fetchrow(
            """select outcome,reason,processed_at from stripe_webhook_events
                 where id=$1""",
            payload["id"],
        )
        incident = await conn.fetchrow(
            """select kind,seen_count,detail from billing_incidents
                 where stripe_event_id=$1""",
            payload["id"],
        )
        ledger_count = await conn.fetchval(
            "select count(*) from credit_ledger where account_id=$1::uuid", account_id
        )
        invoice_count = await conn.fetchval(
            "select count(*) from stripe_invoice_state where account_id=$1::uuid", account_id
        )

    assert account is not None and tuple(account) == ("free", None, "none", 0)
    assert inbox is not None and tuple(inbox)[:2] == ("ignored", expected_reason)
    assert inbox["processed_at"] is not None
    assert incident is not None
    assert (incident["kind"], incident["seen_count"]) == ("webhook_contract_mismatch", 1)
    assert incident["detail"]["event_api_version"] == payload["api_version"]
    assert ledger_count == 0
    assert invoice_count == 0


@pytest.mark.parametrize(
    "event_type",
    [
        "checkout.session.completed",
        "checkout.session.expired",
        "invoice.paid",
        "invoice.payment_failed",
        "customer.subscription.updated",
        "customer.subscription.deleted",
        "charge.refunded",
        "charge.dispute.created",
    ],
)
async def test_supported_event_without_object_identity_fails_closed_durably(
    event_type: str, processor: EventProcessor, pool: asyncpg.Pool
) -> None:
    payload = event(event_type, {}, event_id=f"evt_invalid_shape_{event_type}")
    result = await processor.process(payload)
    duplicate = await processor.process(payload)

    async with pool.acquire() as conn:
        inbox = await conn.fetchrow(
            "select outcome,reason,processed_at from stripe_webhook_events where id=$1",
            payload["id"],
        )
        incident = await conn.fetchrow(
            "select kind,detail from billing_incidents where stripe_event_id=$1",
            payload["id"],
        )
    assert result.outcome == "ignored"
    assert duplicate.outcome == "duplicate"
    assert inbox is not None
    assert inbox["outcome"] == "ignored"
    assert inbox["processed_at"] is not None
    assert incident is not None and incident["kind"] == "invalid_event_shape"
    assert incident["detail"]["event_type"] == event_type


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("id", None),
        ("id", 123),
        ("id", " padded "),
        ("id", "delete\x7f"),
        ("id", "zero\u200bwidth"),
        ("id", "x" * 513),
        ("type", None),
        ("type", 123),
        ("type", " padded "),
        ("type", "delete\x7f"),
        ("type", "zero\u200bwidth"),
        ("type", "x" * 256),
    ],
)
async def test_invalid_event_identity_uses_stable_payload_hash_audit_id(
    field: str, value: object, processor: EventProcessor, pool: asyncpg.Pool
) -> None:
    payload = paid_invoice("00000000-0000-0000-0000-000000000001")
    payload[field] = value
    digest = event_payload_sha256(payload)
    expected_id = payload["id"] if field == "type" else f"invalid-event:{digest}"

    result = await processor.process(payload)
    duplicate = await processor.process(payload)
    async with pool.acquire() as conn:
        inbox = await conn.fetchrow(
            "select event_type,outcome,processed_at from stripe_webhook_events where id=$1",
            expected_id,
        )
        incident = await conn.fetchrow(
            "select kind,stripe_event_id from billing_incidents where stripe_event_id=$1",
            expected_id,
        )
    assert result.outcome == "ignored"
    assert duplicate.outcome == "duplicate"
    assert inbox is not None
    assert inbox["event_type"] == ("invalid" if field == "type" else "invoice.paid")
    assert inbox["outcome"] == "ignored"
    assert inbox["processed_at"] is not None
    assert incident is not None and tuple(incident) == ("invalid_event_shape", expected_id)


@pytest.mark.parametrize(
    "malformation", ["created", "created_overflow", "livemode", "data", "object"]
)
async def test_supported_event_top_level_shape_drift_is_not_retried_forever(
    malformation: str, processor: EventProcessor, pool: asyncpg.Pool
) -> None:
    payload = event(
        "invoice.paid",
        {"id": f"in_invalid_{malformation}"},
        event_id=f"evt_invalid_{malformation}",
    )
    if malformation == "created":
        payload["created"] = "not-an-integer"
    elif malformation == "created_overflow":
        payload["created"] = POSTGRES_BIGINT_MAX + 1
    elif malformation == "livemode":
        payload["livemode"] = "false"
    elif malformation == "data":
        payload["data"] = []
    else:
        payload["data"]["object"] = []

    result = await processor.process(payload)
    async with pool.acquire() as conn:
        incident = await conn.fetchrow(
            "select kind,detail from billing_incidents where stripe_event_id=$1",
            payload["id"],
        )
    assert result.outcome == "ignored"
    assert incident is not None and incident["kind"] == "invalid_event_shape"
    assert incident["detail"]["reason"] == result.reason


async def test_paid_invoice_grants_from_invoice_snapshot(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    result = await processor.process(paid_invoice(account_id))
    assert result.outcome == "handled"
    account = await _account(pool, account_id)
    assert (account["plan_key"], account["plan_interval"]) == ("starter", "month")
    assert account["subscription_status"] == "active"
    assert account["credits_balance"] == 300
    rows = await _ledger(pool, account_id)
    assert [(row["reason"], row["delta"], row["grant_slot"]) for row in rows] == [
        ("subscription_grant", 300, 1)
    ]


async def test_same_event_id_is_duplicate(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    payload = paid_invoice(account_id, event_id="evt_same")
    assert (await processor.process(payload)).outcome == "handled"
    assert (await processor.process(payload)).outcome == "duplicate"
    assert len(await _ledger(pool, account_id)) == 1


@pytest.mark.parametrize("changed_field", ["payload", "event_type", "livemode"])
async def test_same_event_id_remains_a_single_delivery_idempotency_key(
    changed_field: str, processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    first = paid_invoice(
        account_id,
        invoice_id=f"in_duplicate_identity_{changed_field}",
        event_id=f"evt_duplicate_identity_{changed_field}",
    )
    duplicate_payload = paid_invoice(
        account_id,
        invoice_id=f"in_duplicate_identity_{changed_field}",
        event_id=f"evt_duplicate_identity_{changed_field}",
    )
    if changed_field == "payload":
        duplicate_payload["data"]["object"]["description"] = "changed payload"
    elif changed_field == "event_type":
        duplicate_payload["type"] = "invoice.payment_failed"
    else:
        duplicate_payload["livemode"] = True

    assert (await processor.process(first)).outcome == "handled"
    duplicate = await processor.process(duplicate_payload)
    async with pool.acquire() as conn:
        ledger_count = await conn.fetchval(
            """select count(*) from credit_ledger
                 where stripe_invoice_id=$1 and grant_slot=1""",
            f"in_duplicate_identity_{changed_field}",
        )
        incident_count = await conn.fetchval(
            "select count(*) from billing_incidents where kind='event_identity_reuse'"
        )
    assert (duplicate.outcome, duplicate.reason) == (
        "duplicate",
        "event id already committed",
    )
    assert ledger_count == 1
    assert incident_count == 0


async def test_different_event_id_same_invoice_is_business_replay(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    first = paid_invoice(account_id, event_id="evt_business_1")
    replay = paid_invoice(account_id, event_id="evt_business_2", created=1_800_000_011)
    assert (await processor.process(first)).outcome == "handled"
    assert (await processor.process(replay)).outcome == "replayed"
    assert len(await _ledger(pool, account_id)) == 1


async def test_new_cycle_resets_credits_instead_of_accumulating(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    await processor.process(paid_invoice(account_id, invoice_id="in_cycle_1"))
    async with pool.acquire() as conn:
        await conn.execute(
            "update billing_accounts set credits_balance=125 where id=$1::uuid", account_id
        )
    await processor.process(
        paid_invoice(
            account_id,
            invoice_id="in_cycle_2",
            event_id="evt_cycle_2",
            created=1_800_000_100,
            period_start=1_802_592_000,
        )
    )
    account = await _account(pool, account_id)
    assert account["credits_balance"] == 300
    rows = await _ledger(pool, account_id)
    assert rows[-1]["delta"] == 175


async def test_unknown_price_fails_closed_and_records_incident(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    payload = paid_invoice(account_id, invoice_id="in_unknown")
    payload["data"]["object"]["lines"]["data"][0]["price"]["lookup_key"] = "bad_key"
    result = await processor.process(payload)
    assert result.outcome == "ignored"
    assert (await _account(pool, account_id))["credits_balance"] == 0
    async with pool.acquire() as conn:
        incident = await conn.fetchrow("select * from billing_incidents")
    assert incident is not None and incident["kind"] == "unknown_price"


async def test_positive_proration_fails_closed(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    result = await processor.process(
        paid_invoice(account_id, invoice_id="in_proration", proration_amount=100)
    )
    assert result.reason == "cross-invoice proration is unsafe"
    async with pool.acquire() as conn:
        assert (
            await conn.fetchval(
                "select count(*) from billing_incidents where kind='unsafe_cross_invoice_proration'"
            )
            == 1
        )


async def test_negative_proration_also_fails_closed_without_funding_lineage(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    result = await processor.process(
        paid_invoice(account_id, invoice_id="in_negative_proration", proration_amount=-500)
    )
    assert result.outcome == "ignored"
    assert (await _account(pool, account_id))["credits_balance"] == 0


async def test_multi_payment_clawback_shape_is_incident_only(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    await processor.process(paid_invoice(account_id, invoice_id="in_multi_payment_clawback"))
    payload = refunded_charge(
        invoice_id="in_multi_payment_clawback",
        amount_refunded=950,
        event_id="evt_multi_payment_clawback",
    )
    payload["data"]["object"]["_unsupported_invoice_payment_shape"] = True

    result = await processor.process(payload)
    account = await _account(pool, account_id)
    async with pool.acquire() as conn:
        state = await conn.fetchrow(
            """select amount_refunded,fully_refunded,disputed
                 from stripe_invoice_state where invoice_id='in_multi_payment_clawback'"""
        )
        incident = await conn.fetchval(
            """select count(*) from billing_incidents
                 where kind='unsupported_invoice_payment_shape'"""
        )
    assert result.outcome == "ignored"
    assert account["credits_balance"] == 300
    assert state is not None and tuple(state) == (0, False, False)
    assert incident == 1


async def test_ambiguous_payment_intent_clawback_is_not_misclassified_as_missing_invoice(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    await processor.process(paid_invoice(account_id, invoice_id="in_preserved_entitlement"))
    payload = refunded_charge(
        invoice_id="in_untrusted_first_mapping",
        amount_refunded=950,
        event_id="evt_ambiguous_payment_intent_mapping",
    )
    charge = payload["data"]["object"]
    charge.pop("invoice")
    charge["payment_intent"] = "pi_shared_across_invoices"
    charge["_unsupported_invoice_payment_shape"] = True

    result = await processor.process(payload)
    account = await _account(pool, account_id)
    async with pool.acquire() as conn:
        unsupported = await conn.fetchval(
            """select count(*) from billing_incidents
                 where kind='unsupported_invoice_payment_shape'"""
        )
        missing = await conn.fetchval(
            "select count(*) from billing_incidents where kind='clawback_without_invoice'"
        )
        invoice_rows = await conn.fetchval(
            """select count(*) from stripe_invoice_state
                 where invoice_id='in_untrusted_first_mapping'"""
        )
    assert result.outcome == "ignored"
    assert account["credits_balance"] == 300
    assert unsupported == 1
    assert missing == 0
    assert invoice_rows == 0


async def test_partial_dispute_conservatively_closes_entire_funding(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    await processor.process(paid_invoice(account_id, invoice_id="in_partial_dispute"))
    payload = dispute(
        invoice_id="in_partial_dispute",
        amount=1900,
        event_id="evt_partial_dispute",
    )
    payload["data"]["object"]["amount"] = 500

    result = await processor.process(payload)
    account = await _account(pool, account_id)
    assert result.outcome == "handled"
    assert account["credits_balance"] == 0
    assert account["entitlement_revoked"] is True


@pytest.mark.parametrize(
    "malformation",
    [
        "missing_customer",
        "amount_not_integer",
        "amount_zero",
        "refund_not_integer",
        "refund_negative",
        "refund_exceeds_amount",
        "refunded_not_boolean",
    ],
)
async def test_malformed_clawback_shape_is_incident_only(
    malformation: str, processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    invoice_id = f"in_bad_clawback_{malformation}"
    await processor.process(paid_invoice(account_id, invoice_id=invoice_id))
    payload = refunded_charge(
        invoice_id=invoice_id,
        amount=1900,
        amount_refunded=950,
        event_id=f"evt_bad_clawback_{malformation}",
    )
    charge = payload["data"]["object"]
    if malformation == "missing_customer":
        charge["customer"] = None
    elif malformation == "amount_not_integer":
        charge["amount"] = "1900"
    elif malformation == "amount_zero":
        charge["amount"] = 0
    elif malformation == "refund_not_integer":
        charge["amount_refunded"] = "950"
    elif malformation == "refund_negative":
        charge["amount_refunded"] = -1
    elif malformation == "refund_exceeds_amount":
        charge["amount_refunded"] = 1901
    else:
        charge["refunded"] = "false"

    result = await processor.process(payload)
    async with pool.acquire() as conn:
        account = await conn.fetchrow(
            "select credits_balance from billing_accounts where id=$1::uuid", account_id
        )
        state = await conn.fetchrow(
            """select amount_refunded,fully_refunded,disputed
                 from stripe_invoice_state where invoice_id=$1""",
            invoice_id,
        )
        incident = await conn.fetchval(
            "select count(*) from billing_incidents where kind='invalid_clawback_shape'"
        )
    assert result.outcome == "ignored"
    assert account is not None and account["credits_balance"] == 300
    assert state is not None and tuple(state) == (0, False, False)
    assert incident == 1


async def test_partial_refund_after_paid_claws_cumulative_ratio(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    await processor.process(paid_invoice(account_id))
    result = await processor.process(refunded_charge(amount_refunded=950))
    assert result.outcome == "handled"
    assert (await _account(pool, account_id))["credits_balance"] == 150
    assert [row["delta"] for row in await _ledger(pool, account_id)] == [300, -150]


async def test_partial_refund_debt_absorbs_same_epoch_usage_refund(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    await processor.process(paid_invoice(account_id, invoice_id="in_spent_partial"))
    credits = CreditService(pool)
    assert (await credits.charge(account_id, 300, "spent-before-refund")).balance == 0
    await processor.process(refunded_charge(invoice_id="in_spent_partial", amount_refunded=950))
    refunded = await credits.refund("spent-before-refund")
    assert refunded.balance == 150
    async with pool.acquire() as conn:
        debt = await conn.fetchrow(
            """select target_units,collected_units from billing_clawback_debts
                 where account_id=$1::uuid and stripe_invoice_id='in_spent_partial'""",
            account_id,
        )
    assert debt is not None and tuple(debt) == (150, 150)


async def test_cross_account_refund_cannot_mutate_invoice_or_balance(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    owner_id = await make_account(customer="cus_owner", subscription="sub_owner")
    other_id = await make_account(customer="cus_other", subscription="sub_other")
    await processor.process(
        paid_invoice(
            owner_id,
            invoice_id="in_owner_only",
            customer="cus_owner",
            subscription="sub_owner",
        )
    )
    result = await processor.process(
        refunded_charge(
            invoice_id="in_owner_only",
            customer="cus_other",
            amount_refunded=1900,
            refunded=True,
            event_id="evt_cross_account_refund",
        )
    )
    assert result.outcome == "ignored"
    async with pool.acquire() as conn:
        owner = await conn.fetchrow(
            "select credits_balance from billing_accounts where id=$1::uuid", owner_id
        )
        other = await conn.fetchrow(
            "select credits_balance from billing_accounts where id=$1::uuid", other_id
        )
        state = await conn.fetchrow(
            """select account_id,amount_refunded,fully_refunded,disputed
                 from stripe_invoice_state where invoice_id='in_owner_only'"""
        )
        incident = await conn.fetchval(
            """select count(*) from billing_incidents
                 where kind='clawback_invoice_identity_conflict'"""
        )
    assert owner is not None and owner["credits_balance"] == 300
    assert other is not None and other["credits_balance"] == 0
    assert state is not None
    assert (str(state["account_id"]), *tuple(state)[1:]) == (
        owner_id,
        0,
        False,
        False,
    )
    assert incident == 1


@pytest.mark.parametrize("refund_first", [False, True])
async def test_partial_refund_order_converges(
    refund_first: bool, processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    paid = paid_invoice(account_id, invoice_id="in_partial_order")
    refund = refunded_charge(invoice_id="in_partial_order", amount_refunded=475)
    for payload in [refund, paid] if refund_first else [paid, refund]:
        await processor.process(payload)
    account = await _account(pool, account_id)
    assert account["credits_balance"] == 225


@pytest.mark.parametrize("refund_first", [False, True])
async def test_full_refund_order_converges(
    refund_first: bool, processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    paid = paid_invoice(account_id, invoice_id="in_full_order")
    refund = refunded_charge(invoice_id="in_full_order", amount_refunded=1900, refunded=True)
    for payload in [refund, paid] if refund_first else [paid, refund]:
        await processor.process(payload)
    account = await _account(pool, account_id)
    assert account["credits_balance"] == 0
    assert account["plan_key"] == "starter"
    async with pool.acquire() as conn:
        state = await conn.fetchrow(
            "select * from stripe_invoice_state where invoice_id='in_full_order'"
        )
    assert state is not None and state["fully_refunded"]


async def test_multiple_partial_refunds_use_cumulative_amount(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    await processor.process(paid_invoice(account_id, invoice_id="in_multi_refund"))
    await processor.process(
        refunded_charge(invoice_id="in_multi_refund", amount_refunded=475, event_id="evt_refund_25")
    )
    await processor.process(
        refunded_charge(invoice_id="in_multi_refund", amount_refunded=950, event_id="evt_refund_50")
    )
    assert (await _account(pool, account_id))["credits_balance"] == 150
    rows = await _ledger(pool, account_id)
    assert [row["delta"] for row in rows] == [300, -75, -75]


@pytest.mark.parametrize("dispute_first", [False, True])
async def test_dispute_order_converges(
    dispute_first: bool, processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    paid = paid_invoice(account_id, invoice_id="in_dispute")
    disputed = dispute(invoice_id="in_dispute")
    for payload in [disputed, paid] if dispute_first else [paid, disputed]:
        await processor.process(payload)
    assert (await _account(pool, account_id))["credits_balance"] == 0
    async with pool.acquire() as conn:
        assert await conn.fetchval(
            "select disputed from stripe_invoice_state where invoice_id='in_dispute'"
        )


async def test_same_second_paid_outranks_payment_failure(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    await processor.process(paid_invoice(account_id, created=200))
    result = await processor.process(payment_failed(account_id, created=200))
    assert result.outcome == "ignored"
    assert (await _account(pool, account_id))["subscription_status"] == "active"


async def test_same_second_subscription_update_tie_creates_reconciliation_incident(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    await processor.process(paid_invoice(account_id, created=200))
    first = subscription_event(
        account_id,
        event_id="evt_subscription_tie_first",
        created=300,
        cancel_at_period_end=False,
    )
    second = subscription_event(
        account_id,
        event_id="evt_subscription_tie_second",
        created=300,
        cancel_at_period_end=True,
    )

    assert (await processor.process(first)).outcome == "handled"
    tied = await processor.process(second)
    account = await _account(pool, account_id)
    async with pool.acquire() as conn:
        incident = await conn.fetchrow(
            """select kind,detail,seen_count from billing_incidents
                 where kind='event_order_tie'"""
        )
    assert tied.outcome == "ignored"
    assert account["cancel_at_period_end"] is False
    assert incident is not None
    assert incident["detail"]["cancel_at_period_end"] is True
    assert incident["seen_count"] == 1


@pytest.mark.parametrize("billing_reason", [None, "manual", 123])
async def test_payment_failure_with_unmodeled_billing_reason_cannot_freeze_account(
    billing_reason: object,
    processor: EventProcessor,
    pool: asyncpg.Pool,
    make_account,
) -> None:
    account_id = await make_account()
    await processor.process(paid_invoice(account_id, created=200))
    failed = payment_failed(
        account_id,
        event_id=f"evt_unmodeled_failure_{billing_reason}",
        created=201,
    )
    failed["data"]["object"]["billing_reason"] = billing_reason

    result = await processor.process(failed)
    account = await _account(pool, account_id)
    async with pool.acquire() as conn:
        incident = await conn.fetchval(
            """select count(*) from billing_incidents
                 where kind='unexpected_payment_failed_reason'"""
        )
    assert result.outcome == "ignored"
    assert (account["subscription_status"], account["credits_balance"]) == ("active", 300)
    assert incident == 1


async def test_newer_payment_failure_freezes_account(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    await processor.process(paid_invoice(account_id, created=200))
    await processor.process(payment_failed(account_id, created=201))
    assert (await _account(pool, account_id))["subscription_status"] == "past_due"


async def test_deleted_subscription_clears_entitlement_and_cannot_be_revived(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    await processor.process(paid_invoice(account_id, created=200))
    await processor.process(
        subscription_event(
            account_id,
            "customer.subscription.deleted",
            status="canceled",
            event_id="evt_deleted",
            created=300,
        )
    )
    stale = await processor.process(
        paid_invoice(
            account_id,
            invoice_id="in_stale",
            event_id="evt_stale_paid",
            created=299,
        )
    )
    assert stale.outcome == "ignored"
    account = await _account(pool, account_id)
    assert (account["plan_key"], account["credits_balance"]) == ("free", 0)


async def test_subscription_update_never_projects_unpaid_plan_or_features(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    result = await processor.process(
        subscription_event(account_id, plan="pro", interval="year", created=100)
    )
    account = await _account(pool, account_id)
    assert result.outcome == "handled"
    assert (account["plan_key"], account["plan_interval"]) == ("starter", "month")
    assert account["credits_balance"] == 0


@pytest.mark.parametrize(
    "malformation",
    [
        "status_unknown",
        "status_not_string",
        "cancel_missing",
        "cancel_not_boolean",
        "period_missing",
        "period_not_integer",
        "period_out_of_range",
    ],
)
async def test_subscription_update_invalid_projection_shape_is_incident_only(
    malformation: str,
    processor: EventProcessor,
    pool: asyncpg.Pool,
    make_account,
) -> None:
    account_id = await make_account()
    payload = subscription_event(
        account_id,
        event_id=f"evt_subscription_projection_{malformation}",
        created=200,
    )
    subscription = payload["data"]["object"]
    item = subscription["items"]["data"][0]
    if malformation == "status_unknown":
        subscription["status"] = "future_status"
    elif malformation == "status_not_string":
        subscription["status"] = 123
    elif malformation == "cancel_missing":
        subscription.pop("cancel_at_period_end")
    elif malformation == "cancel_not_boolean":
        subscription["cancel_at_period_end"] = "false"
    elif malformation == "period_missing":
        item.pop("current_period_end")
        subscription.pop("current_period_end")
    elif malformation == "period_not_integer":
        item["current_period_end"] = "1802592000"
    else:
        item["current_period_end"] = 10**30

    result = await processor.process(payload)
    account = await _account(pool, account_id)
    async with pool.acquire() as conn:
        incident = await conn.fetchval(
            """select count(*) from billing_incidents
                 where kind='invalid_subscription_projection'"""
        )
    assert result.outcome == "ignored"
    assert (
        account["stripe_subscription_id"],
        account["subscription_status"],
        account["event_created"],
    ) == ("sub_test", "active", 0)
    assert incident == 1


@pytest.mark.parametrize("quantity", [None, 2, "1"])
async def test_subscription_update_requires_exactly_one_item_quantity(
    quantity: object, processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    payload = subscription_event(account_id, event_id=f"evt_subscription_quantity_{quantity}")
    payload["data"]["object"]["items"]["data"][0]["quantity"] = quantity

    result = await processor.process(payload)
    account = await _account(pool, account_id)
    async with pool.acquire() as conn:
        incident = await conn.fetchval(
            """select count(*) from billing_incidents
                 where kind='ambiguous_subscription_items'"""
        )
    assert result.outcome == "ignored"
    assert (account["event_created"], account["subscription_status"]) == (0, "active")
    assert incident == 1


async def test_subscription_update_rejects_incomplete_item_pagination(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    payload = subscription_event(account_id, event_id="evt_subscription_items_paginated")
    payload["data"]["object"]["items"]["has_more"] = True

    result = await processor.process(payload)
    account = await _account(pool, account_id)
    async with pool.acquire() as conn:
        incident = await conn.fetchval(
            """select count(*) from billing_incidents
                 where kind='ambiguous_subscription_items'"""
        )
    assert result.outcome == "ignored"
    assert (account["event_created"], account["subscription_status"]) == (0, "active")
    assert incident == 1


async def test_subscription_update_rejects_price_product_identity_drift(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    payload = subscription_event(account_id, event_id="evt_subscription_product_drift")
    payload["data"]["object"]["items"]["data"][0]["_resolved_price"]["product"]["metadata"][
        "product_line"
    ] = "other-product"

    result = await processor.process(payload)
    account = await _account(pool, account_id)
    async with pool.acquire() as conn:
        incident = await conn.fetchval(
            """select count(*) from billing_incidents
                 where kind='ambiguous_subscription_items'"""
        )
    assert result.outcome == "ignored"
    assert (account["subscription_status"], account["event_created"]) == ("active", 0)
    assert incident == 1


async def test_unbound_subscription_update_requires_product_line_even_with_valid_claim(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account(customer=None, subscription=None)
    claim_token = uuid.uuid4()
    async with pool.acquire() as conn:
        await conn.execute(
            """insert into checkout_claims(
                   account_id,claim_token,plan_key,plan_interval,expires_at,
                   client_request_key)
                 values($1::uuid,$2,'starter','month',now()+interval '30 minutes',
                        'legacy-unbound-subscription')""",
            account_id,
            claim_token,
        )
    payload = subscription_event(
        account_id,
        subscription="sub_unbound_missing_product_line",
        event_id="evt_unbound_missing_product_line",
        created=100,
    )
    metadata = payload["data"]["object"]["metadata"]
    metadata["claim_token"] = str(claim_token)
    metadata.pop("product_line")

    result = await processor.process(payload)
    async with pool.acquire() as conn:
        account = await conn.fetchrow(
            "select stripe_customer_id,stripe_subscription_id from billing_accounts where id=$1",
            account_id,
        )
        claim_count = await conn.fetchval(
            "select count(*) from checkout_claims where account_id=$1", account_id
        )
        incident = await conn.fetchval(
            "select count(*) from billing_incidents where kind='product_line_identity_conflict'"
        )
    assert result.outcome == "ignored"
    assert account is not None and tuple(account) == (None, None)
    assert claim_count == 1
    assert incident == 1


async def test_unbound_subscription_update_cannot_authorize_checkoutless_paid_invoice(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account(customer=None, subscription=None)
    update = subscription_event(
        account_id,
        subscription="sub_unowned",
        event_id="evt_unowned_subscription_update",
        created=100,
    )
    updated = await processor.process(update)
    paid = await processor.process(
        paid_invoice(
            account_id,
            invoice_id="in_unowned_subscription",
            subscription="sub_unowned",
            billing_reason="subscription_create",
            event_id="evt_unowned_subscription_paid",
            created=101,
        )
    )

    account = await _account(pool, account_id)
    async with pool.acquire() as conn:
        incidents = await conn.fetch("select kind from billing_incidents order by kind")
    assert updated.outcome == "ignored"
    assert paid.outcome == "ignored"
    assert (
        account["stripe_subscription_id"],
        account["plan_key"],
        account["subscription_status"],
        account["credits_balance"],
    ) == (None, "free", "none", 0)
    assert [row["kind"] for row in incidents] == [
        "subscription_create_without_checkout",
        "subscription_update_without_authority",
    ]


@pytest.mark.parametrize(
    ("kind", "expected"),
    [
        ("payment_failed", ("sub_test", "starter", "past_due", 300)),
        ("subscription_updated", ("sub_test", "starter", "active", 300)),
        ("subscription_deleted", (None, "free", "canceled", 0)),
    ],
)
async def test_bound_subscription_events_allow_legacy_missing_product_line(
    kind: str,
    expected: tuple[str | None, str, str, int],
    processor: EventProcessor,
    pool: asyncpg.Pool,
    make_account,
) -> None:
    account_id = await make_account()
    await processor.process(
        paid_invoice(account_id, invoice_id=f"in_before_legacy_product_line_{kind}", created=100)
    )
    if kind == "payment_failed":
        payload = payment_failed(
            account_id,
            event_id=f"evt_legacy_product_line_{kind}",
            created=200,
        )
    else:
        payload = subscription_event(
            account_id,
            (
                "customer.subscription.deleted"
                if kind == "subscription_deleted"
                else "customer.subscription.updated"
            ),
            status="canceled" if kind == "subscription_deleted" else "active",
            event_id=f"evt_legacy_product_line_{kind}",
            created=200,
        )
    payload["data"]["object"]["metadata"].pop("product_line")

    result = await processor.process(payload)
    account = await _account(pool, account_id)
    async with pool.acquire() as conn:
        incidents = await conn.fetchval(
            "select count(*) from billing_incidents where kind='product_line_identity_conflict'"
        )
    assert result.outcome == "handled"
    assert (
        account["stripe_subscription_id"],
        account["plan_key"],
        account["subscription_status"],
        account["credits_balance"],
    ) == expected
    assert incidents == 0


@pytest.mark.parametrize(
    "kind",
    ["payment_failed", "subscription_updated", "subscription_deleted"],
)
async def test_subscription_events_reject_conflicting_product_line(
    kind: str,
    processor: EventProcessor,
    pool: asyncpg.Pool,
    make_account,
) -> None:
    account_id = await make_account()
    await processor.process(
        paid_invoice(
            account_id, invoice_id=f"in_before_conflicting_product_line_{kind}", created=100
        )
    )
    if kind == "payment_failed":
        payload = payment_failed(
            account_id,
            event_id=f"evt_conflicting_product_line_{kind}",
            created=200,
        )
    else:
        payload = subscription_event(
            account_id,
            (
                "customer.subscription.deleted"
                if kind == "subscription_deleted"
                else "customer.subscription.updated"
            ),
            status="canceled" if kind == "subscription_deleted" else "active",
            event_id=f"evt_conflicting_product_line_{kind}",
            created=200,
        )
    payload["data"]["object"]["metadata"]["product_line"] = "other-product"

    result = await processor.process(payload)
    account = await _account(pool, account_id)
    async with pool.acquire() as conn:
        incidents = await conn.fetchval(
            "select count(*) from billing_incidents where kind='product_line_identity_conflict'"
        )
    assert result.outcome == "ignored"
    assert (
        account["stripe_subscription_id"],
        account["plan_key"],
        account["subscription_status"],
        account["credits_balance"],
    ) == ("sub_test", "starter", "active", 300)
    assert incidents == 1


@pytest.mark.parametrize(
    ("kind", "incident_kind"),
    [
        ("payment_failed", "payment_failed_customer_identity_conflict"),
        ("subscription_updated", "subscription_customer_identity_conflict"),
        ("subscription_deleted", "subscription_customer_identity_conflict"),
    ],
)
async def test_subscription_events_require_customer_identity(
    kind: str,
    incident_kind: str,
    processor: EventProcessor,
    pool: asyncpg.Pool,
    make_account,
) -> None:
    account_id = await make_account()
    await processor.process(
        paid_invoice(account_id, invoice_id=f"in_before_missing_customer_{kind}", created=100)
    )
    if kind == "payment_failed":
        payload = payment_failed(
            account_id,
            event_id="evt_missing_customer_failed",
            created=200,
        )
    else:
        payload = subscription_event(
            account_id,
            (
                "customer.subscription.deleted"
                if kind == "subscription_deleted"
                else "customer.subscription.updated"
            ),
            status="canceled" if kind == "subscription_deleted" else "active",
            event_id=f"evt_missing_customer_{kind}",
            created=200,
        )
    payload["data"]["object"]["customer"] = None

    result = await processor.process(payload)
    account = await _account(pool, account_id)
    async with pool.acquire() as conn:
        incidents = await conn.fetchval(
            "select count(*) from billing_incidents where kind=$1",
            incident_kind,
        )
    assert result.outcome == "ignored"
    assert (
        account["stripe_subscription_id"],
        account["plan_key"],
        account["subscription_status"],
        account["credits_balance"],
    ) == ("sub_test", "starter", "active", 300)
    assert incidents == 1


async def test_wrong_subscription_payment_failure_cannot_freeze_paid_access(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    await processor.process(paid_invoice(account_id, event_id="evt_paid_before_wrong_failure"))
    failed = payment_failed(
        account_id, event_id="evt_wrong_subscription_failure", created=1_900_000_000
    )
    failed["data"]["object"]["subscription"] = "sub_other"

    result = await processor.process(failed)
    account = await _account(pool, account_id)
    async with pool.acquire() as conn:
        incident = await conn.fetchval(
            """select count(*) from billing_incidents
                 where kind='payment_failed_subscription_identity_conflict'"""
        )
    assert result.outcome == "ignored"
    assert (account["subscription_status"], account["credits_balance"]) == ("active", 300)
    assert incident == 1


async def test_unbound_subscription_deletion_cannot_poison_account_ordering(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account(customer=None, subscription=None)
    deleted = subscription_event(
        account_id,
        "customer.subscription.deleted",
        status="canceled",
        subscription="sub_unbound_deleted",
        event_id="evt_unbound_deleted",
        created=500,
    )

    result = await processor.process(deleted)
    account = await _account(pool, account_id)
    assert result.outcome == "ignored"
    assert (
        account["stripe_subscription_id"],
        account["plan_key"],
        account["grant_epoch"],
        account["event_created"],
        account["event_rank"],
    ) == (None, "free", 0, 0, 0)


async def test_deleted_annual_subscription_can_start_new_monthly_checkout_same_second(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account(subscription="sub_old")
    old_period_end = 1_831_536_000
    async with pool.acquire() as conn:
        await conn.execute(
            """update billing_accounts set plan_key='starter',plan_interval='year'
                 where id=$1::uuid""",
            account_id,
        )
    assert (
        await processor.process(
            paid_invoice(
                account_id,
                invoice_id="in_old_annual",
                subscription="sub_old",
                plan="starter",
                interval="year",
                period_end=old_period_end,
                event_id="evt_old_annual_paid",
                created=200,
            )
        )
    ).outcome == "handled"
    change_id = uuid.uuid4()
    async with pool.acquire() as conn:
        account = await conn.fetchrow(
            "select * from billing_accounts where id=$1::uuid", account_id
        )
        assert account is not None
        await conn.execute(
            """insert into billing_plan_changes(
                   id,account_id,idempotency_key,stripe_subscription_id,
                   from_plan_key,from_interval,target_plan_key,target_interval,
                   effective_mode,status,stripe_request_key,expected_grant_epoch,
                   expected_entitlement_period_end,expected_subscription_status,
                   expected_cancel_at_period_end)
                 values($1,$2::uuid,'old-sub-change','sub_old','starter','year',
                        'pro','year','period_end','applying',$3,$4,$5,$6,false)""",
            change_id,
            account_id,
            f"plan-change:{change_id}",
            account["grant_epoch"],
            account["entitlement_period_end"],
            account["subscription_status"],
        )
        await conn.execute(
            """insert into billing_incidents(kind,dedupe_key,account_id,detail)
                 values('plan_change_recovery_required',$1,$2::uuid,$3::jsonb)""",
            f"{account_id}:{change_id}",
            account_id,
            {"plan_change_id": str(change_id), "status": "applying"},
        )
    assert (
        await processor.process(
            subscription_event(
                account_id,
                "customer.subscription.deleted",
                status="canceled",
                subscription="sub_old",
                event_id="evt_old_deleted",
                created=300,
            )
        )
    ).outcome == "handled"
    after_delete = await _account(pool, account_id)
    assert after_delete["entitlement_period_end"] is None
    async with pool.acquire() as conn:
        change = await conn.fetchrow(
            """select status,last_error,completed_at
                 from billing_plan_changes where id=$1::uuid""",
            change_id,
        )
        incident_resolved = await conn.fetchval(
            """select resolved_at is not null from billing_incidents
                 where kind='plan_change_recovery_required'"""
        )
    assert change is not None
    assert (change["status"], change["last_error"]) == (
        "failed",
        "subscription_deleted",
    )
    assert change["completed_at"] is not None
    assert incident_resolved is True

    token = uuid.uuid4()
    async with pool.acquire() as conn:
        await conn.execute(
            """insert into checkout_claims(
                   account_id,claim_token,plan_key,plan_interval,expires_at,
                   client_request_key,session_id,session_url)
                 values($1::uuid,$2,'starter','month',now()+interval '30 minutes',
                        'replacement-checkout','cs_replacement','https://checkout.test/replacement')""",
            account_id,
            token,
        )
    completed = checkout_event(
        "checkout.session.completed",
        account_id,
        "cs_replacement",
        subscription="sub_replacement",
        event_id="evt_replacement_checkout",
        claim_token=str(token),
    )
    completed["created"] = 300
    completed["data"]["object"]["customer"] = "cus_test"
    assert (await processor.process(completed)).outcome == "handled"

    replacement = await processor.process(
        paid_invoice(
            account_id,
            invoice_id="in_replacement_month",
            subscription="sub_replacement",
            plan="starter",
            interval="month",
            period_start=1_800_000_000,
            period_end=1_802_592_000,
            billing_reason="subscription_create",
            event_id="evt_replacement_paid",
            created=300,
        )
    )
    stale_old_delete = await processor.process(
        subscription_event(
            account_id,
            "customer.subscription.deleted",
            status="canceled",
            subscription="sub_old",
            event_id="evt_old_deleted_late_copy",
            created=301,
        )
    )
    account = await _account(pool, account_id)
    assert replacement.outcome == "handled"
    assert stale_old_delete.outcome == "ignored"
    assert (
        account["stripe_subscription_id"],
        account["plan_key"],
        account["plan_interval"],
        account["subscription_status"],
        account["credits_balance"],
    ) == ("sub_replacement", "starter", "month", "active", 300)


async def test_unhandled_event_is_audited_without_side_effects(
    processor: EventProcessor, pool: asyncpg.Pool
) -> None:
    payload = event(
        "customer.created",
        {
            "id": "cus_other",
            "email": "private@example.test",
            "metadata": {"free_form": "private note"},
        },
    )
    payload["_raw_payload_sha256"] = "c" * 64
    result = await processor.process(payload)
    assert result.outcome == "ignored"
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """select outcome,processed_at,payload,payload_sha256
                 from stripe_webhook_events"""
        )
    assert row is not None and row["outcome"] == "ignored" and row["processed_at"] is not None
    assert row["payload_sha256"] == "c" * 64
    assert row["payload"]["data"]["object"]["email"] == "[redacted]"
    assert row["payload"]["data"]["object"]["metadata"]["free_form"] == "[redacted]"


async def test_incident_deduplication_updates_seen_count(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    for event_id in ("evt_bad_1", "evt_bad_2"):
        payload = paid_invoice(account_id, invoice_id="in_same_bad", event_id=event_id)
        payload["data"]["object"]["lines"]["data"][0]["price"]["lookup_key"] = "bad"
        await processor.process(payload)
    async with pool.acquire() as conn:
        rows = await conn.fetch("select * from billing_incidents")
    assert len(rows) == 1 and rows[0]["seen_count"] == 2


async def test_processing_exception_rolls_back_event_claim(
    processor: EventProcessor, pool: asyncpg.Pool, catalog, make_account
) -> None:
    account_id = await make_account()
    payload = paid_invoice(account_id, event_id="evt_retry_after_rollback")

    class ExplodingProcessor(EventProcessor):
        async def _dispatch(self, conn, event):  # type: ignore[no-untyped-def]
            raise RuntimeError("simulated crash")

    exploding = ExplodingProcessor(pool, catalog, "example-entitlements")
    with pytest.raises(RuntimeError, match="simulated crash"):
        await exploding.process(payload)
    async with pool.acquire() as conn:
        assert (
            await conn.fetchval(
                "select count(*) from stripe_webhook_events where id='evt_retry_after_rollback'"
            )
            == 0
        )
    assert (await processor.process(payload)).outcome == "handled"


async def test_ledger_delta_sum_matches_current_balance(
    processor: EventProcessor, pool: asyncpg.Pool, make_account
) -> None:
    account_id = await make_account()
    await processor.process(paid_invoice(account_id))
    await processor.process(refunded_charge(amount_refunded=475))
    async with pool.acquire() as conn:
        balance, ledger_sum = await conn.fetchrow(
            """select a.credits_balance,
                 (select coalesce(sum(delta),0) from credit_ledger where account_id=a.id)
                 from billing_accounts a where id=$1::uuid""",
            account_id,
        )
    assert balance == ledger_sum == 225
