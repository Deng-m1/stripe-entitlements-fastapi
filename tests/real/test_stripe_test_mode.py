from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from typing import Any

import asyncpg
import pytest
import stripe

from stripe_entitlements.catalog import PlanCatalog
from stripe_entitlements.processor import EventProcessor
from stripe_entitlements.stripe_gateway import StripeGateway

pytestmark = pytest.mark.real_stripe


def _test_key() -> str:
    __tracebackhide__ = True
    key = os.getenv("STRIPE_SECRET_KEY", "")
    if not key:
        pytest.skip("STRIPE_SECRET_KEY is not configured")
    if not key.startswith("sk_test_"):
        pytest.fail("real Stripe tests refuse keys that do not start with sk_test_")
    return key


def _dict(value: Any) -> dict[str, Any]:
    parsed: dict[str, Any] = json.loads(str(value))
    return parsed


async def _wait_event(key: str, event_type: str, object_id: str) -> dict[str, Any]:
    __tracebackhide__ = True
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        page = await asyncio.to_thread(
            stripe.Event.list, type=event_type, limit=20, api_key=key
        )
        for candidate in page.data:
            event = _dict(candidate)
            obj = event.get("data", {}).get("object", {})
            if obj.get("id") == object_id:
                return event
            if event_type == "charge.refunded" and obj.get("invoice") == object_id:
                return event
        await asyncio.sleep(1)
    raise AssertionError(f"Stripe did not expose {event_type} for {object_id}")


async def _latest_charge_for_invoice(key: str, invoice_id: str) -> str:
    payments = await asyncio.to_thread(
        stripe.InvoicePayment.list, invoice=invoice_id, limit=10, api_key=key
    )
    for payment in payments.data:
        raw = _dict(payment)
        payment_ref = raw.get("payment") or {}
        intent_id = payment_ref.get("payment_intent")
        if intent_id:
            intent = await asyncio.to_thread(
                stripe.PaymentIntent.retrieve, intent_id, api_key=key
            )
            if intent.latest_charge:
                return str(intent.latest_charge)
    raise AssertionError("paid invoice has no retrievable charge")


async def test_real_paid_and_refund_events_converge_in_postgres(
    pool: asyncpg.Pool, catalog: PlanCatalog, make_account
) -> None:
    key = _test_key()
    run_id = uuid.uuid4().hex[:12]
    prefix = f"t{run_id}"
    product_line = f"stripe-entitlements-real-{run_id}"
    account_id = await make_account(customer=None, subscription=None)
    product = None
    price = None
    customer = None
    subscription = None
    try:
        product = await asyncio.to_thread(
            stripe.Product.create,
            name=f"Stripe Entitlements real test {run_id}",
            metadata={"automated_test": "true", "run_id": run_id},
            api_key=key,
        )
        price = await asyncio.to_thread(
            stripe.Price.create,
            product=product.id,
            currency="usd",
            unit_amount=1900,
            recurring={"interval": "month"},
            lookup_key=f"{prefix}_starter_month",
            metadata={"automated_test": "true", "run_id": run_id},
            api_key=key,
        )
        customer = await asyncio.to_thread(
            stripe.Customer.create,
            name=f"Automated test {run_id}",
            metadata={"automated_test": "true", "account_id": account_id},
            api_key=key,
        )
        payment_method = await asyncio.to_thread(
            stripe.PaymentMethod.attach,
            "pm_card_visa",
            customer=customer.id,
            api_key=key,
        )
        await asyncio.to_thread(
            stripe.Customer.modify,
            customer.id,
            invoice_settings={"default_payment_method": payment_method.id},
            api_key=key,
        )
        subscription = await asyncio.to_thread(
            stripe.Subscription.create,
            customer=customer.id,
            items=[{"price": price.id}],
            payment_behavior="error_if_incomplete",
            metadata={"account_id": account_id, "product_line": product_line},
            api_key=key,
        )
        async with pool.acquire() as conn:
            await conn.execute(
                """update billing_accounts set stripe_customer_id=$2,
                     stripe_subscription_id=$3 where id=$1::uuid""",
                account_id,
                customer.id,
                subscription.id,
            )
        invoices = await asyncio.to_thread(
            stripe.Invoice.list, subscription=subscription.id, status="paid", limit=1, api_key=key
        )
        assert invoices.data
        invoice_id = str(invoices.data[0].id)
        paid_event = await _wait_event(key, "invoice.paid", invoice_id)
        gateway = StripeGateway(key, "whsec_not_used", product_line)
        prepared_paid = await gateway.prepare_event(paid_event)
        real_catalog = PlanCatalog(catalog.plans, prefix)
        processor = EventProcessor(pool, real_catalog, product_line)
        paid_result = await processor.process(prepared_paid)
        assert paid_result.outcome == "handled"
        async with pool.acquire() as conn:
            assert await conn.fetchval(
                "select credits_balance from billing_accounts where id=$1::uuid", account_id
            ) == 300

        charge_id = await _latest_charge_for_invoice(key, invoice_id)
        await asyncio.to_thread(
            stripe.Refund.create, charge=charge_id, amount=950, api_key=key
        )
        refund_event = await _wait_event(key, "charge.refunded", charge_id)
        prepared_refund = await gateway.prepare_event(refund_event)
        refund_result = await processor.process(prepared_refund)
        assert refund_result.outcome == "handled"
        async with pool.acquire() as conn:
            assert await conn.fetchval(
                "select credits_balance from billing_accounts where id=$1::uuid", account_id
            ) == 150
    finally:
        if subscription is not None:
            try:
                await asyncio.to_thread(
                    stripe.Subscription.delete, subscription.id, api_key=key
                )
            except stripe.StripeError:
                pass
        if customer is not None:
            try:
                await asyncio.to_thread(stripe.Customer.delete, customer.id, api_key=key)
            except stripe.StripeError:
                pass
        if price is not None:
            try:
                await asyncio.to_thread(stripe.Price.modify, price.id, active=False, api_key=key)
            except stripe.StripeError:
                pass
        if product is not None:
            try:
                await asyncio.to_thread(
                    stripe.Product.modify, product.id, active=False, api_key=key
                )
            except stripe.StripeError:
                pass


async def test_real_test_clock_can_advance_and_return_ready() -> None:
    key = _test_key()
    clock = await asyncio.to_thread(
        stripe.test_helpers.TestClock.create,
        frozen_time=int(time.time()),
        name=f"stripe-entitlements-{uuid.uuid4().hex[:8]}",
        api_key=key,
    )
    try:
        target = int(clock.frozen_time) + 3600
        await asyncio.to_thread(
            stripe.test_helpers.TestClock.advance,
            clock.id,
            frozen_time=target,
            api_key=key,
        )
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            current = await asyncio.to_thread(
                stripe.test_helpers.TestClock.retrieve, clock.id, api_key=key
            )
            if current.status == "ready" and int(current.frozen_time) == target:
                break
            await asyncio.sleep(1)
        else:
            raise AssertionError("Stripe Test Clock did not return to ready")
    finally:
        await asyncio.to_thread(
            stripe.test_helpers.TestClock.delete, clock.id, api_key=key
        )
