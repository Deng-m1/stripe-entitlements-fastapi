from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from datetime import UTC, datetime
from typing import Any

import asyncpg
import pytest
import stripe

from stripe_entitlements.catalog import PlanCatalog
from stripe_entitlements.plan_changes import PlanChangeCoordinator
from stripe_entitlements.processor import EventProcessor
from stripe_entitlements.stripe_gateway import StripeGateway

pytestmark = pytest.mark.real_stripe
STRIPE_API_VERSION = "2026-06-24.dahlia"


def _options(key: str) -> dict[str, str]:
    return {"api_key": key, "stripe_version": STRIPE_API_VERSION}


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
            stripe.Event.list, type=event_type, limit=20, **_options(key)
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
        stripe.InvoicePayment.list, invoice=invoice_id, limit=10, **_options(key)
    )
    for payment in payments.data:
        raw = _dict(payment)
        payment_ref = raw.get("payment") or {}
        intent_id = payment_ref.get("payment_intent")
        if intent_id:
            intent = await asyncio.to_thread(
                stripe.PaymentIntent.retrieve, intent_id, **_options(key)
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
            **_options(key),
        )
        price = await asyncio.to_thread(
            stripe.Price.create,
            product=product.id,
            currency="usd",
            unit_amount=1900,
            recurring={"interval": "month"},
            lookup_key=f"{prefix}_starter_month",
            metadata={"automated_test": "true", "run_id": run_id},
            **_options(key),
        )
        customer = await asyncio.to_thread(
            stripe.Customer.create,
            name=f"Automated test {run_id}",
            metadata={"automated_test": "true", "account_id": account_id},
            **_options(key),
        )
        payment_method = await asyncio.to_thread(
            stripe.PaymentMethod.attach,
            "pm_card_visa",
            customer=customer.id,
            **_options(key),
        )
        await asyncio.to_thread(
            stripe.Customer.modify,
            customer.id,
            invoice_settings={"default_payment_method": payment_method.id},
            **_options(key),
        )
        subscription = await asyncio.to_thread(
            stripe.Subscription.create,
            customer=customer.id,
            items=[{"price": price.id}],
            payment_behavior="error_if_incomplete",
            metadata={"account_id": account_id, "product_line": product_line},
            **_options(key),
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
            stripe.Invoice.list,
            subscription=subscription.id,
            status="paid",
            limit=1,
            **_options(key),
        )
        assert invoices.data
        invoice_id = str(invoices.data[0].id)
        paid_event = await _wait_event(key, "invoice.paid", invoice_id)
        observed_event_version = str(paid_event.get("api_version") or "")
        assert observed_event_version
        gateway = StripeGateway(
            key, "whsec_not_used", product_line, api_version=STRIPE_API_VERSION
        )
        prepared_paid = await gateway.prepare_event(paid_event)
        real_catalog = PlanCatalog(catalog.plans, prefix)
        processor = EventProcessor(
            pool,
            real_catalog,
            product_line,
            # Event snapshots keep the API version used when Stripe created them;
            # the explicit request pin above cannot re-render Event.list history.
            expected_api_version=observed_event_version,
        )
        paid_result = await processor.process(prepared_paid)
        assert paid_result.outcome == "handled"
        async with pool.acquire() as conn:
            assert await conn.fetchval(
                "select credits_balance from billing_accounts where id=$1::uuid", account_id
            ) == 300

        charge_id = await _latest_charge_for_invoice(key, invoice_id)
        await asyncio.to_thread(
            stripe.Refund.create, charge=charge_id, amount=950, **_options(key)
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
                    stripe.Subscription.delete, subscription.id, **_options(key)
                )
            except stripe.StripeError:
                pass
        if customer is not None:
            try:
                await asyncio.to_thread(
                    stripe.Customer.delete, customer.id, **_options(key)
                )
            except stripe.StripeError:
                pass
        if price is not None:
            try:
                await asyncio.to_thread(
                    stripe.Price.modify, price.id, active=False, **_options(key)
                )
            except stripe.StripeError:
                pass
        if product is not None:
            try:
                await asyncio.to_thread(
                    stripe.Product.modify, product.id, active=False, **_options(key)
                )
            except stripe.StripeError:
                pass


async def test_real_midcycle_upgrade_is_full_price_and_webhook_authoritative(
    pool: asyncpg.Pool, catalog: PlanCatalog, make_account
) -> None:
    key = _test_key()
    run_id = uuid.uuid4().hex[:12]
    prefix = f"s{run_id}"
    product_line = f"stripe-entitlements-upgrade-{run_id}"
    account_id = await make_account(customer=None, subscription=None)
    product = None
    starter_price = None
    pro_price = None
    customer = None
    subscription = None
    try:
        product = await asyncio.to_thread(
            stripe.Product.create,
            name=f"Stripe Entitlements upgrade test {run_id}",
            metadata={"automated_test": "true", "run_id": run_id},
            **_options(key),
        )
        starter_price = await asyncio.to_thread(
            stripe.Price.create,
            product=product.id,
            currency="usd",
            unit_amount=1900,
            recurring={"interval": "month"},
            lookup_key=f"{prefix}_starter_month",
            metadata={"automated_test": "true", "run_id": run_id},
            **_options(key),
        )
        pro_price = await asyncio.to_thread(
            stripe.Price.create,
            product=product.id,
            currency="usd",
            unit_amount=4900,
            recurring={"interval": "month"},
            lookup_key=f"{prefix}_pro_month",
            metadata={"automated_test": "true", "run_id": run_id},
            **_options(key),
        )
        customer = await asyncio.to_thread(
            stripe.Customer.create,
            name=f"Automated upgrade test {run_id}",
            metadata={"automated_test": "true", "account_id": account_id},
            **_options(key),
        )
        payment_method = await asyncio.to_thread(
            stripe.PaymentMethod.attach,
            "pm_card_visa",
            customer=customer.id,
            **_options(key),
        )
        await asyncio.to_thread(
            stripe.Customer.modify,
            customer.id,
            invoice_settings={"default_payment_method": payment_method.id},
            **_options(key),
        )
        subscription = await asyncio.to_thread(
            stripe.Subscription.create,
            customer=customer.id,
            items=[{"price": starter_price.id}],
            payment_behavior="error_if_incomplete",
            metadata={"account_id": account_id, "product_line": product_line},
            **_options(key),
        )
        subscription_raw = _dict(subscription)
        item = subscription_raw["items"]["data"][0]
        period_end = datetime.fromtimestamp(int(item["current_period_end"]), tz=UTC)
        async with pool.acquire() as conn:
            await conn.execute(
                """update billing_accounts set stripe_customer_id=$2,
                     stripe_subscription_id=$3,plan_key='starter',plan_interval='month',
                     subscription_status='active',current_period_end=$4,
                     entitlement_period_end=$4,credit_expires_at=$4,
                     entitlement_revoked=false where id=$1::uuid""",
                account_id,
                customer.id,
                subscription.id,
                period_end,
            )

        gateway = StripeGateway(
            key, "whsec_not_used", product_line, api_version=STRIPE_API_VERSION
        )
        coordinator = PlanChangeCoordinator(
            pool, PlanCatalog(catalog.plans, prefix), gateway
        )
        preview = await coordinator.preview_remote(
            account_id, "pro", "month", f"real-upgrade-{run_id}"
        )
        assert preview.decision.timing == "immediate"
        assert preview.estimated_credit_applied == 0
        assert preview.estimated_customer_balance_credit == 0
        assert preview.estimated_amount_due == 4900

        result = await coordinator.confirm(account_id, preview.change_id)
        assert result.status == "applied"
        updated = await asyncio.to_thread(
            stripe.Subscription.retrieve, subscription.id, **_options(key)
        )
        updated_raw = _dict(updated)
        latest_invoice = updated_raw.get("latest_invoice")
        invoice_id = (
            str(latest_invoice.get("id"))
            if isinstance(latest_invoice, dict)
            else str(latest_invoice)
        )
        assert invoice_id and invoice_id != "None"
        paid_event = await _wait_event(key, "invoice.paid", invoice_id)
        observed_event_version = str(paid_event.get("api_version") or "")
        assert observed_event_version
        prepared = await gateway.prepare_event(paid_event)
        processor = EventProcessor(
            pool,
            PlanCatalog(catalog.plans, prefix),
            product_line,
            expected_api_version=observed_event_version,
        )
        processed = await processor.process(prepared)
        assert processed.outcome == "handled"
        async with pool.acquire() as conn:
            account = await conn.fetchrow(
                "select plan_key,plan_interval,credits_balance from billing_accounts "
                "where id=$1::uuid",
                account_id,
            )
            change_status = await conn.fetchval(
                "select status from billing_plan_changes where id=$1::uuid",
                preview.change_id,
            )
        assert account is not None
        assert tuple(account) == ("pro", "month", 1000)
        assert change_status == "completed"
    finally:
        if subscription is not None:
            try:
                await asyncio.to_thread(
                    stripe.Subscription.delete, subscription.id, **_options(key)
                )
            except stripe.StripeError:
                pass
        if customer is not None:
            try:
                await asyncio.to_thread(
                    stripe.Customer.delete, customer.id, **_options(key)
                )
            except stripe.StripeError:
                pass
        for price in (starter_price, pro_price):
            if price is not None:
                try:
                    await asyncio.to_thread(
                        stripe.Price.modify, price.id, active=False, **_options(key)
                    )
                except stripe.StripeError:
                    pass
        if product is not None:
            try:
                await asyncio.to_thread(
                    stripe.Product.modify, product.id, active=False, **_options(key)
                )
            except stripe.StripeError:
                pass


async def test_real_annual_origin_change_builds_period_end_schedule(
    pool: asyncpg.Pool, catalog: PlanCatalog, make_account
) -> None:
    key = _test_key()
    run_id = uuid.uuid4().hex[:12]
    prefix = f"a{run_id}"
    product_line = f"stripe-entitlements-annual-schedule-{run_id}"
    account_id = await make_account(customer=None, subscription=None)
    product = None
    starter_price = None
    pro_price = None
    customer = None
    subscription = None
    schedule_id: str | None = None
    try:
        product = await asyncio.to_thread(
            stripe.Product.create,
            name=f"Stripe Entitlements annual schedule test {run_id}",
            metadata={"automated_test": "true", "run_id": run_id},
            **_options(key),
        )
        starter_price = await asyncio.to_thread(
            stripe.Price.create,
            product=product.id,
            currency="usd",
            unit_amount=13_700,
            recurring={"interval": "year"},
            lookup_key=f"{prefix}_starter_year",
            metadata={"automated_test": "true", "run_id": run_id},
            **_options(key),
        )
        pro_price = await asyncio.to_thread(
            stripe.Price.create,
            product=product.id,
            currency="usd",
            unit_amount=35_300,
            recurring={"interval": "year"},
            lookup_key=f"{prefix}_pro_year",
            metadata={"automated_test": "true", "run_id": run_id},
            **_options(key),
        )
        customer = await asyncio.to_thread(
            stripe.Customer.create,
            name=f"Automated annual schedule test {run_id}",
            metadata={"automated_test": "true", "account_id": account_id},
            **_options(key),
        )
        payment_method = await asyncio.to_thread(
            stripe.PaymentMethod.attach,
            "pm_card_visa",
            customer=customer.id,
            **_options(key),
        )
        await asyncio.to_thread(
            stripe.Customer.modify,
            customer.id,
            invoice_settings={"default_payment_method": payment_method.id},
            **_options(key),
        )
        subscription = await asyncio.to_thread(
            stripe.Subscription.create,
            customer=customer.id,
            items=[{"price": starter_price.id}],
            payment_behavior="error_if_incomplete",
            metadata={"account_id": account_id, "product_line": product_line},
            **_options(key),
        )
        subscription_raw = _dict(subscription)
        item = subscription_raw["items"]["data"][0]
        period_end = datetime.fromtimestamp(int(item["current_period_end"]), tz=UTC)
        async with pool.acquire() as conn:
            await conn.execute(
                """update billing_accounts set stripe_customer_id=$2,
                     stripe_subscription_id=$3,plan_key='starter',plan_interval='year',
                     subscription_status='active',current_period_end=$4,
                     entitlement_period_end=$4,credit_expires_at=$4,
                     entitlement_revoked=false where id=$1::uuid""",
                account_id,
                customer.id,
                subscription.id,
                period_end,
            )

        gateway = StripeGateway(
            key, "whsec_not_used", product_line, api_version=STRIPE_API_VERSION
        )
        coordinator = PlanChangeCoordinator(
            pool, PlanCatalog(catalog.plans, prefix), gateway
        )
        preview = await coordinator.preview_remote(
            account_id, "pro", "year", f"real-annual-schedule-{run_id}"
        )
        assert preview.decision.timing == "period_end"
        assert preview.estimated_amount_due is None
        result = await coordinator.confirm(account_id, preview.change_id)
        assert result.status == "scheduled"
        assert result.effective_at == period_end
        async with pool.acquire() as conn:
            schedule_id = await conn.fetchval(
                "select stripe_schedule_id from billing_plan_changes where id=$1::uuid",
                preview.change_id,
            )
        assert schedule_id
        schedule = await asyncio.to_thread(
            stripe.SubscriptionSchedule.retrieve, schedule_id, **_options(key)
        )
        schedule_raw = _dict(schedule)
        phases = schedule_raw.get("phases") or []
        assert len(phases) == 2
        assert phases[0]["end_date"] == phases[1]["start_date"]
        target_price = phases[1]["items"][0]["price"]
        target_price_id = (
            str(target_price.get("id"))
            if isinstance(target_price, dict)
            else str(target_price)
        )
        assert target_price_id == pro_price.id
        assert schedule_raw.get("end_behavior") == "release"
    finally:
        if schedule_id:
            try:
                await asyncio.to_thread(
                    stripe.SubscriptionSchedule.release,
                    schedule_id,
                    **_options(key),
                )
            except stripe.StripeError:
                pass
        if subscription is not None:
            try:
                await asyncio.to_thread(
                    stripe.Subscription.delete, subscription.id, **_options(key)
                )
            except stripe.StripeError:
                pass
        if customer is not None:
            try:
                await asyncio.to_thread(
                    stripe.Customer.delete, customer.id, **_options(key)
                )
            except stripe.StripeError:
                pass
        for price in (starter_price, pro_price):
            if price is not None:
                try:
                    await asyncio.to_thread(
                        stripe.Price.modify, price.id, active=False, **_options(key)
                    )
                except stripe.StripeError:
                    pass
        if product is not None:
            try:
                await asyncio.to_thread(
                    stripe.Product.modify, product.id, active=False, **_options(key)
                )
            except stripe.StripeError:
                pass


async def test_real_test_clock_can_advance_and_return_ready() -> None:
    key = _test_key()
    clock = await asyncio.to_thread(
        stripe.test_helpers.TestClock.create,
        frozen_time=int(time.time()),
        name=f"stripe-entitlements-{uuid.uuid4().hex[:8]}",
        **_options(key),
    )
    try:
        target = int(clock.frozen_time) + 3600
        await asyncio.to_thread(
            stripe.test_helpers.TestClock.advance,
            clock.id,
            frozen_time=target,
            **_options(key),
        )
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            current = await asyncio.to_thread(
                stripe.test_helpers.TestClock.retrieve, clock.id, **_options(key)
            )
            if current.status == "ready" and int(current.frozen_time) == target:
                break
            await asyncio.sleep(1)
        else:
            raise AssertionError("Stripe Test Clock did not return to ready")
    finally:
        await asyncio.to_thread(
            stripe.test_helpers.TestClock.delete, clock.id, **_options(key)
        )
