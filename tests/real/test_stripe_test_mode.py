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

from stripe_entitlements.annual import AnnualGrantService
from stripe_entitlements.catalog import PlanCatalog
from stripe_entitlements.plan_changes import PlanChangeCoordinator
from stripe_entitlements.processor import EventProcessor
from stripe_entitlements.stripe_gateway import StripeGateway

pytestmark = pytest.mark.real_stripe
STRIPE_API_VERSION = "2026-06-24.dahlia"


def _options(key: str) -> dict[str, str]:
    return {"api_key": key, "stripe_version": STRIPE_API_VERSION}


def _create_options(key: str, run_id: str, label: str) -> dict[str, str]:
    return {**_options(key), "idempotency_key": f"real-test:{run_id}:{label}"}


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


async def _advance_clock(key: str, clock_id: str, target: int) -> None:
    await asyncio.to_thread(
        stripe.test_helpers.TestClock.advance,
        clock_id,
        frozen_time=target,
        **_options(key),
    )
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        current = await asyncio.to_thread(
            stripe.test_helpers.TestClock.retrieve, clock_id, **_options(key)
        )
        if current.status == "ready" and int(current.frozen_time) == target:
            return
        await asyncio.sleep(1)
    raise AssertionError("Stripe Test Clock did not return to ready")


async def _wait_paid_invoice(
    key: str,
    subscription_id: str,
    *,
    excluding: set[str] | None = None,
    billing_reason: str | None = None,
) -> dict[str, Any]:
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        invoices = await asyncio.to_thread(
            stripe.Invoice.list,
            subscription=subscription_id,
            status="paid",
            limit=10,
            **_options(key),
        )
        for candidate in invoices.data:
            raw = _dict(candidate)
            if excluding and str(raw.get("id")) in excluding:
                continue
            if billing_reason and raw.get("billing_reason") != billing_reason:
                continue
            return raw
        await asyncio.sleep(1)
    raise AssertionError("Stripe did not expose the expected paid invoice")


async def _cleanup_call(
    errors: list[str], label: str, operation: Any, /, *args: Any, **kwargs: Any
) -> None:
    try:
        await asyncio.to_thread(operation, *args, **kwargs)
    except stripe.StripeError as exc:
        errors.append(f"{label}:{type(exc).__name__}")


def _assert_cleanup(errors: list[str]) -> None:
    if errors:
        pytest.fail("real Stripe cleanup failed: " + ", ".join(errors))


async def _cleanup_standard_objects(
    errors: list[str],
    key: str,
    *,
    subscription: Any,
    customer: Any,
    prices: tuple[Any, ...],
    product: Any,
) -> None:
    if subscription is not None:
        await _cleanup_call(
            errors,
            "subscription",
            stripe.Subscription.delete,
            subscription.id,
            **_options(key),
        )
    if customer is not None:
        await _cleanup_call(
            errors,
            "customer",
            stripe.Customer.delete,
            customer.id,
            **_options(key),
        )
    for price in prices:
        if price is not None:
            await _cleanup_call(
                errors,
                "price",
                stripe.Price.modify,
                price.id,
                active=False,
                **_options(key),
            )
    if product is not None:
        await _cleanup_call(
            errors,
            "product",
            stripe.Product.modify,
            product.id,
            active=False,
            **_options(key),
        )


async def _cleanup_schedule(
    errors: list[str],
    key: str,
    schedule_id: str,
    subscription_id: str,
    run_id: str,
) -> None:
    try:
        schedule = await asyncio.to_thread(
            stripe.SubscriptionSchedule.retrieve, schedule_id, **_options(key)
        )
        raw = _dict(schedule)
        subscription = raw.get("subscription")
        actual_subscription_id = (
            str(subscription.get("id"))
            if isinstance(subscription, dict)
            else str(subscription or "")
        )
        product_line = str((raw.get("metadata") or {}).get("product_line") or "")
        if (
            bool(raw.get("livemode"))
            or actual_subscription_id != subscription_id
            or product_line != f"stripe-entitlements-annual-schedule-{run_id}"
        ):
            errors.append("subscription_schedule:ownership_mismatch")
            return
        if raw.get("status") not in {"released", "canceled", "completed"}:
            await _cleanup_call(
                errors,
                "subscription_schedule",
                stripe.SubscriptionSchedule.release,
                schedule_id,
                **_options(key),
            )
    except stripe.StripeError as exc:
        errors.append(f"subscription_schedule:{type(exc).__name__}")


async def _sweep_run_objects(errors: list[str], key: str, run_id: str) -> None:
    owned_subscriptions: list[dict[str, Any]] = []
    try:
        subscriptions = await asyncio.to_thread(
            stripe.Subscription.list, status="all", limit=100, **_options(key)
        )
        for subscription in subscriptions.data:
            raw = _dict(subscription)
            if (raw.get("metadata") or {}).get("run_id") == run_id:
                owned_subscriptions.append(raw)
    except stripe.StripeError as exc:
        errors.append(f"subscription_inventory:{type(exc).__name__}")

    owned_subscription_ids = {str(raw["id"]) for raw in owned_subscriptions}
    try:
        schedules = await asyncio.to_thread(
            stripe.SubscriptionSchedule.list, limit=100, **_options(key)
        )
        for schedule in schedules.data:
            raw = _dict(schedule)
            metadata = raw.get("metadata") or {}
            subscription = raw.get("subscription")
            subscription_id = (
                str(subscription.get("id"))
                if isinstance(subscription, dict)
                else str(subscription or "")
            )
            if (
                subscription_id in owned_subscription_ids
                and run_id in str(metadata.get("product_line") or "")
                and raw.get("status") not in {"released", "canceled", "completed"}
            ):
                await _cleanup_call(
                    errors,
                    "swept_subscription_schedule",
                    stripe.SubscriptionSchedule.release,
                    raw["id"],
                    **_options(key),
                )
    except stripe.StripeError as exc:
        errors.append(f"schedule_sweep:{type(exc).__name__}")

    for raw in owned_subscriptions:
        if raw.get("status") != "canceled":
            await _cleanup_call(
                errors,
                "swept_subscription",
                stripe.Subscription.delete,
                raw["id"],
                **_options(key),
            )

    try:
        customers = await asyncio.to_thread(stripe.Customer.list, limit=100, **_options(key))
        for customer in customers.data:
            raw = _dict(customer)
            if (raw.get("metadata") or {}).get("run_id") == run_id:
                await _cleanup_call(
                    errors,
                    "swept_customer",
                    stripe.Customer.delete,
                    raw["id"],
                    **_options(key),
                )
    except stripe.StripeError as exc:
        errors.append(f"customer_sweep:{type(exc).__name__}")

    for resource, label in ((stripe.Price, "price"), (stripe.Product, "product")):
        try:
            resources = await asyncio.to_thread(resource.list, limit=100, **_options(key))
            for candidate in resources.data:
                raw = _dict(candidate)
                if (
                    (raw.get("metadata") or {}).get("run_id") == run_id
                    and bool(raw.get("active"))
                ):
                    await _cleanup_call(
                        errors,
                        f"swept_{label}",
                        resource.modify,
                        raw["id"],
                        active=False,
                        **_options(key),
                    )
        except stripe.StripeError as exc:
            errors.append(f"{label}_sweep:{type(exc).__name__}")

    try:
        clocks = await asyncio.to_thread(
            stripe.test_helpers.TestClock.list, limit=100, **_options(key)
        )
        for clock in clocks.data:
            raw = _dict(clock)
            if raw.get("name") == f"stripe-entitlements-annual-{run_id}":
                await _cleanup_call(
                    errors,
                    "swept_test_clock",
                    stripe.test_helpers.TestClock.delete,
                    raw["id"],
                    **_options(key),
                )
    except stripe.StripeError as exc:
        errors.append(f"test_clock_sweep:{type(exc).__name__}")


async def test_real_paid_and_refund_events_converge_in_postgres(
    pool: asyncpg.Pool, catalog: PlanCatalog, make_account
) -> None:
    key = _test_key()
    run_id = uuid.uuid4().hex[:12]
    cleanup_errors: list[str] = []
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
            **_create_options(key, run_id, "product"),
        )
        price = await asyncio.to_thread(
            stripe.Price.create,
            product=product.id,
            currency="usd",
            unit_amount=1900,
            recurring={"interval": "month"},
            lookup_key=f"{prefix}_starter_month",
            metadata={"automated_test": "true", "run_id": run_id},
            **_create_options(key, run_id, "starter-price"),
        )
        customer = await asyncio.to_thread(
            stripe.Customer.create,
            name=f"Automated test {run_id}",
            metadata={
                "automated_test": "true",
                "run_id": run_id,
                "account_id": account_id,
            },
            **_create_options(key, run_id, "customer"),
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
            metadata={
                "account_id": account_id,
                "product_line": product_line,
                "run_id": run_id,
            },
            **_create_options(key, run_id, "subscription"),
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
        await _cleanup_standard_objects(
            cleanup_errors,
            key,
            subscription=subscription,
            customer=customer,
            prices=(price,),
            product=product,
        )
        await _sweep_run_objects(cleanup_errors, key, run_id)
        _assert_cleanup(cleanup_errors)


async def test_real_midcycle_upgrade_is_full_price_and_webhook_authoritative(
    pool: asyncpg.Pool, catalog: PlanCatalog, make_account
) -> None:
    key = _test_key()
    run_id = uuid.uuid4().hex[:12]
    cleanup_errors: list[str] = []
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
            **_create_options(key, run_id, "product"),
        )
        starter_price = await asyncio.to_thread(
            stripe.Price.create,
            product=product.id,
            currency="usd",
            unit_amount=1900,
            recurring={"interval": "month"},
            lookup_key=f"{prefix}_starter_month",
            metadata={"automated_test": "true", "run_id": run_id},
            **_create_options(key, run_id, "starter-price"),
        )
        pro_price = await asyncio.to_thread(
            stripe.Price.create,
            product=product.id,
            currency="usd",
            unit_amount=4900,
            recurring={"interval": "month"},
            lookup_key=f"{prefix}_pro_month",
            metadata={"automated_test": "true", "run_id": run_id},
            **_create_options(key, run_id, "pro-price"),
        )
        customer = await asyncio.to_thread(
            stripe.Customer.create,
            name=f"Automated upgrade test {run_id}",
            metadata={
                "automated_test": "true",
                "run_id": run_id,
                "account_id": account_id,
            },
            **_create_options(key, run_id, "customer"),
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
            metadata={
                "account_id": account_id,
                "product_line": product_line,
                "run_id": run_id,
            },
            **_create_options(key, run_id, "subscription"),
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
        real_catalog = PlanCatalog(catalog.plans, prefix)
        coordinator = PlanChangeCoordinator(pool, real_catalog, gateway)
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
        await _cleanup_standard_objects(
            cleanup_errors,
            key,
            subscription=subscription,
            customer=customer,
            prices=(starter_price, pro_price),
            product=product,
        )
        await _sweep_run_objects(cleanup_errors, key, run_id)
        _assert_cleanup(cleanup_errors)


@pytest.mark.parametrize(
    "failure_payment_method",
    ["pm_card_authenticationRequired", "pm_card_chargeCustomerFail"],
)
async def test_real_failed_immediate_change_keeps_old_entitlement(
    failure_payment_method: str,
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    make_account,
) -> None:
    key = _test_key()
    run_id = uuid.uuid4().hex[:12]
    cleanup_errors: list[str] = []
    prefix = f"f{run_id}"
    product_line = f"stripe-entitlements-failed-change-{run_id}"
    account_id = await make_account(customer=None, subscription=None)
    product = None
    starter_price = None
    pro_price = None
    customer = None
    subscription = None
    try:
        product = await asyncio.to_thread(
            stripe.Product.create,
            name=f"Stripe Entitlements failed change test {run_id}",
            metadata={"automated_test": "true", "run_id": run_id},
            **_create_options(key, run_id, "product"),
        )
        starter_price = await asyncio.to_thread(
            stripe.Price.create,
            product=product.id,
            currency="usd",
            unit_amount=1900,
            recurring={"interval": "month"},
            lookup_key=f"{prefix}_starter_month",
            metadata={"automated_test": "true", "run_id": run_id},
            **_create_options(key, run_id, "starter-price"),
        )
        pro_price = await asyncio.to_thread(
            stripe.Price.create,
            product=product.id,
            currency="usd",
            unit_amount=4900,
            recurring={"interval": "month"},
            lookup_key=f"{prefix}_pro_month",
            metadata={"automated_test": "true", "run_id": run_id},
            **_create_options(key, run_id, "pro-price"),
        )
        customer = await asyncio.to_thread(
            stripe.Customer.create,
            name=f"Automated failed change test {run_id}",
            metadata={
                "automated_test": "true",
                "run_id": run_id,
                "account_id": account_id,
            },
            **_create_options(key, run_id, "customer"),
        )
        working_payment_method = await asyncio.to_thread(
            stripe.PaymentMethod.attach,
            "pm_card_visa",
            customer=customer.id,
            **_options(key),
        )
        await asyncio.to_thread(
            stripe.Customer.modify,
            customer.id,
            invoice_settings={"default_payment_method": working_payment_method.id},
            **_options(key),
        )
        subscription = await asyncio.to_thread(
            stripe.Subscription.create,
            customer=customer.id,
            items=[{"price": starter_price.id}],
            payment_behavior="error_if_incomplete",
            metadata={
                "account_id": account_id,
                "product_line": product_line,
                "run_id": run_id,
            },
            **_create_options(key, run_id, "subscription"),
        )
        subscription_raw = _dict(subscription)
        period_end = datetime.fromtimestamp(
            int(subscription_raw["items"]["data"][0]["current_period_end"]), tz=UTC
        )
        async with pool.acquire() as conn:
            await conn.execute(
                """update billing_accounts set stripe_customer_id=$2,
                     stripe_subscription_id=$3,plan_key='starter',plan_interval='month',
                     subscription_status='active',credits_balance=300,grant_epoch=1,
                     current_period_end=$4,entitlement_period_end=$4,credit_expires_at=$4,
                     entitlement_revoked=false where id=$1::uuid""",
                account_id,
                customer.id,
                subscription.id,
                period_end,
            )

        gateway = StripeGateway(
            key, "whsec_not_used", product_line, api_version=STRIPE_API_VERSION
        )
        real_catalog = PlanCatalog(catalog.plans, prefix)
        coordinator = PlanChangeCoordinator(pool, real_catalog, gateway)
        preview = await coordinator.preview_remote(
            account_id, "pro", "month", f"real-failed-change-{run_id}"
        )
        assert preview.decision.timing == "immediate"
        assert preview.estimated_amount_due == 4900
        assert preview.estimated_credit_applied == 0

        failing_payment_method = await asyncio.to_thread(
            stripe.PaymentMethod.attach,
            failure_payment_method,
            customer=customer.id,
            **_options(key),
        )
        await asyncio.to_thread(
            stripe.Customer.modify,
            customer.id,
            invoice_settings={"default_payment_method": failing_payment_method.id},
            **_options(key),
        )
        result = await coordinator.confirm(account_id, preview.change_id)
        assert result.status == "requires_action"
        assert result.recovery_url or result.client_secret
        if failure_payment_method == "pm_card_authenticationRequired":
            assert result.client_secret

        remote = await asyncio.to_thread(
            stripe.Subscription.retrieve,
            subscription.id,
            expand=["latest_invoice"],
            **_options(key),
        )
        remote_raw = _dict(remote)
        assert remote_raw.get("pending_update")
        current_price = remote_raw["items"]["data"][0]["price"]
        current_price_id = (
            str(current_price.get("id"))
            if isinstance(current_price, dict)
            else str(current_price)
        )
        assert current_price_id == starter_price.id
        invoice = remote_raw.get("latest_invoice") or {}
        assert isinstance(invoice, dict) and invoice.get("status") == "open"
        failure_event = await _wait_event(key, "invoice.payment_failed", str(invoice["id"]))
        observed_event_version = str(failure_event.get("api_version") or "")
        assert observed_event_version
        processor = EventProcessor(
            pool,
            real_catalog,
            product_line,
            expected_api_version=observed_event_version,
        )
        failure_result = await processor.process(
            await gateway.prepare_event(failure_event)
        )
        assert failure_result.outcome == "ignored"
        assert (
            failure_result.reason
            == "optional plan change payment failed; paid entitlement retained"
        )

        async with pool.acquire() as conn:
            account = await conn.fetchrow(
                """select plan_key,plan_interval,subscription_status,credits_balance,
                          grant_epoch,entitlement_revoked,credit_expires_at,
                          entitlement_period_end
                     from billing_accounts where id=$1::uuid""",
                account_id,
            )
            stored = await conn.fetchrow(
                "select * from billing_plan_changes where id=$1::uuid",
                preview.change_id,
            )
            ledger_count = await conn.fetchval(
                "select count(*) from credit_ledger where account_id=$1::uuid", account_id
            )
            incident_count = await conn.fetchval(
                """select count(*) from billing_incidents
                     where account_id=$1::uuid and kind='plan_change_payment_failed'""",
                account_id,
            )
        assert account is not None
        assert tuple(account) == (
            "starter",
            "month",
            "active",
            300,
            1,
            False,
            period_end,
            period_end,
        )
        assert account["credit_expires_at"] > datetime.now(UTC)
        assert stored is not None and stored["status"] == "requires_action"
        assert ledger_count == 0
        assert incident_count == 1
        if result.client_secret:
            assert result.client_secret not in str(dict(stored))
    finally:
        await _cleanup_standard_objects(
            cleanup_errors,
            key,
            subscription=subscription,
            customer=customer,
            prices=(starter_price, pro_price),
            product=product,
        )
        await _sweep_run_objects(cleanup_errors, key, run_id)
        _assert_cleanup(cleanup_errors)


async def test_real_annual_origin_change_builds_period_end_schedule(
    pool: asyncpg.Pool, catalog: PlanCatalog, make_account
) -> None:
    key = _test_key()
    run_id = uuid.uuid4().hex[:12]
    cleanup_errors: list[str] = []
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
            **_create_options(key, run_id, "product"),
        )
        starter_price = await asyncio.to_thread(
            stripe.Price.create,
            product=product.id,
            currency="usd",
            unit_amount=13_700,
            recurring={"interval": "year"},
            lookup_key=f"{prefix}_starter_year",
            metadata={"automated_test": "true", "run_id": run_id},
            **_create_options(key, run_id, "starter-price"),
        )
        pro_price = await asyncio.to_thread(
            stripe.Price.create,
            product=product.id,
            currency="usd",
            unit_amount=35_300,
            recurring={"interval": "year"},
            lookup_key=f"{prefix}_pro_year",
            metadata={"automated_test": "true", "run_id": run_id},
            **_create_options(key, run_id, "pro-price"),
        )
        customer = await asyncio.to_thread(
            stripe.Customer.create,
            name=f"Automated annual schedule test {run_id}",
            metadata={
                "automated_test": "true",
                "run_id": run_id,
                "account_id": account_id,
            },
            **_create_options(key, run_id, "customer"),
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
            metadata={
                "account_id": account_id,
                "product_line": product_line,
                "run_id": run_id,
            },
            **_create_options(key, run_id, "subscription"),
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
        if schedule_id and subscription is not None:
            await _cleanup_schedule(
                cleanup_errors,
                key,
                schedule_id,
                str(subscription.id),
                run_id,
            )
        await _cleanup_standard_objects(
            cleanup_errors,
            key,
            subscription=subscription,
            customer=customer,
            prices=(starter_price, pro_price),
            product=product,
        )
        await _sweep_run_objects(cleanup_errors, key, run_id)
        _assert_cleanup(cleanup_errors)


async def test_real_test_clock_annual_slots_downtime_and_renewal(
    pool: asyncpg.Pool, catalog: PlanCatalog, make_account
) -> None:
    key = _test_key()
    run_id = uuid.uuid4().hex[:12]
    cleanup_errors: list[str] = []
    prefix = f"c{run_id}"
    product_line = f"stripe-entitlements-clock-{run_id}"
    account_id = await make_account(customer=None, subscription=None)
    clock = None
    product = None
    annual_price = None
    customer = None
    subscription = None
    try:
        clock = await asyncio.to_thread(
            stripe.test_helpers.TestClock.create,
            frozen_time=int(time.time()),
            name=f"stripe-entitlements-annual-{run_id}",
            **_create_options(key, run_id, "test-clock"),
        )
        product = await asyncio.to_thread(
            stripe.Product.create,
            name=f"Stripe Entitlements annual clock test {run_id}",
            metadata={"automated_test": "true", "run_id": run_id},
            **_create_options(key, run_id, "product"),
        )
        annual_price = await asyncio.to_thread(
            stripe.Price.create,
            product=product.id,
            currency="usd",
            unit_amount=13_700,
            recurring={"interval": "year"},
            lookup_key=f"{prefix}_starter_year",
            metadata={"automated_test": "true", "run_id": run_id},
            **_create_options(key, run_id, "starter-price"),
        )
        customer = await asyncio.to_thread(
            stripe.Customer.create,
            name=f"Automated annual clock test {run_id}",
            test_clock=clock.id,
            metadata={
                "automated_test": "true",
                "run_id": run_id,
                "account_id": account_id,
            },
            **_create_options(key, run_id, "customer"),
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
            items=[{"price": annual_price.id}],
            payment_behavior="error_if_incomplete",
            metadata={
                "account_id": account_id,
                "product_line": product_line,
                "run_id": run_id,
            },
            **_create_options(key, run_id, "subscription"),
        )
        subscription_raw = _dict(subscription)
        item = subscription_raw["items"]["data"][0]
        initial_period_end = int(item["current_period_end"])
        async with pool.acquire() as conn:
            await conn.execute(
                """update billing_accounts set stripe_customer_id=$2,
                     stripe_subscription_id=$3 where id=$1::uuid""",
                account_id,
                customer.id,
                subscription.id,
            )

        initial_invoice = await _wait_paid_invoice(key, subscription.id)
        initial_invoice_id = str(initial_invoice["id"])
        initial_event = await _wait_event(key, "invoice.paid", initial_invoice_id)
        observed_event_version = str(initial_event.get("api_version") or "")
        assert observed_event_version
        real_catalog = PlanCatalog(catalog.plans, prefix)
        gateway = StripeGateway(
            key, "whsec_not_used", product_line, api_version=STRIPE_API_VERSION
        )
        processor = EventProcessor(
            pool,
            real_catalog,
            product_line,
            expected_api_version=observed_event_version,
        )
        initial_result = await processor.process(await gateway.prepare_event(initial_event))
        assert initial_result.outcome == "handled"
        async with pool.acquire() as conn:
            initial_account = await conn.fetchrow(
                """select plan_key,plan_interval,subscription_status,credits_balance,
                          grant_epoch,annual_grants_issued,funding_invoice_id,
                          entitlement_revoked,credit_expires_at
                     from billing_accounts where id=$1::uuid""",
                account_id,
            )
        assert initial_account is not None
        assert tuple(initial_account)[:8] == (
            "starter",
            "year",
            "active",
            300,
            1,
            1,
            initial_invoice_id,
            False,
        )
        assert initial_account["credit_expires_at"] > datetime.fromtimestamp(
            int(clock.frozen_time), tz=UTC
        )

        service = AnnualGrantService(pool, real_catalog, processor)
        first_month_target = int(clock.frozen_time) + 32 * 86_400
        await _advance_clock(key, clock.id, first_month_target)
        first_snapshot = await gateway.subscription_snapshot(subscription.id)
        first_month_result = await service.grant_due(
            account_id,
            datetime.fromtimestamp(first_month_target, tz=UTC),
            first_snapshot,
        )
        assert first_month_result.reason == "granted annual slot 2"
        async with pool.acquire() as conn:
            first_month_account = await conn.fetchrow(
                """select subscription_status,credits_balance,grant_epoch,
                          annual_grants_issued,entitlement_revoked,credit_expires_at
                     from billing_accounts where id=$1::uuid""",
                account_id,
            )
        assert first_month_account is not None
        assert tuple(first_month_account)[:5] == ("active", 300, 2, 2, False)
        assert first_month_account["credit_expires_at"] > datetime.fromtimestamp(
            first_month_target, tz=UTC
        )

        downtime_target = int(clock.frozen_time) + 190 * 86_400
        await _advance_clock(key, clock.id, downtime_target)
        downtime_now = datetime.fromtimestamp(downtime_target, tz=UTC)
        async with pool.acquire() as conn:
            account_before_jump = await conn.fetchrow(
                "select annual_anchor from billing_accounts where id=$1::uuid", account_id
            )
            assert account_before_jump is not None
            boundaries = int(
                await conn.fetchval(
                    """select coalesce(max(slot),0) from generate_series(1,12) slot
                         where $1::timestamptz + make_interval(months => slot)
                           <= $2::timestamptz""",
                    account_before_jump["annual_anchor"],
                    downtime_now,
                )
                or 0
            )
        expected_jump_slot = min(boundaries + 1, 12)
        assert expected_jump_slot > 2
        downtime_snapshot = await gateway.subscription_snapshot(subscription.id)
        downtime_result = await service.grant_due(
            account_id, downtime_now, downtime_snapshot
        )
        assert downtime_result.reason == f"granted annual slot {expected_jump_slot}"
        async with pool.acquire() as conn:
            old_slots = await conn.fetch(
                """select grant_slot from credit_ledger
                     where stripe_invoice_id=$1 order by grant_slot""",
                initial_invoice_id,
            )
            downtime_account = await conn.fetchrow(
                """select subscription_status,credits_balance,grant_epoch,
                          annual_grants_issued,entitlement_revoked,credit_expires_at
                     from billing_accounts where id=$1::uuid""",
                account_id,
            )
        assert [row["grant_slot"] for row in old_slots] == [
            1,
            2,
            expected_jump_slot,
        ]
        assert downtime_account is not None
        assert tuple(downtime_account)[:5] == (
            "active",
            300,
            3,
            expected_jump_slot,
            False,
        )
        assert downtime_account["credit_expires_at"] > downtime_now

        renewal_target = initial_period_end + 3600
        await _advance_clock(key, clock.id, renewal_target)
        renewal_invoice = await _wait_paid_invoice(
            key,
            subscription.id,
            excluding={initial_invoice_id},
            billing_reason="subscription_cycle",
        )
        renewal_invoice_id = str(renewal_invoice["id"])
        renewal_event = await _wait_event(key, "invoice.paid", renewal_invoice_id)
        assert renewal_event.get("api_version") == observed_event_version
        renewal_result = await processor.process(
            await gateway.prepare_event(renewal_event)
        )
        assert renewal_result.outcome == "handled"
        async with pool.acquire() as conn:
            account = await conn.fetchrow(
                """select plan_key,plan_interval,subscription_status,credits_balance,
                          grant_epoch,annual_grants_issued,funding_invoice_id,
                          entitlement_revoked,credit_expires_at,entitlement_period_end
                     from billing_accounts where id=$1::uuid""",
                account_id,
            )
            renewal_slots = await conn.fetch(
                """select grant_slot from credit_ledger
                     where stripe_invoice_id=$1 order by grant_slot""",
                renewal_invoice_id,
            )
        assert account is not None
        assert tuple(account)[:8] == (
            "starter",
            "year",
            "active",
            300,
            4,
            1,
            renewal_invoice_id,
            False,
        )
        renewal_now = datetime.fromtimestamp(renewal_target, tz=UTC)
        assert account["credit_expires_at"] > renewal_now
        assert account["entitlement_period_end"] > datetime.fromtimestamp(
            initial_period_end, tz=UTC
        )
        assert [row["grant_slot"] for row in renewal_slots] == [1]
    finally:
        await _cleanup_standard_objects(
            cleanup_errors,
            key,
            subscription=subscription,
            customer=customer,
            prices=(annual_price,),
            product=product,
        )
        if clock is not None:
            await _cleanup_call(
                cleanup_errors,
                "test_clock",
                stripe.test_helpers.TestClock.delete,
                clock.id,
                **_options(key),
            )
        await _sweep_run_objects(cleanup_errors, key, run_id)
        _assert_cleanup(cleanup_errors)
