from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import asyncpg
import pytest
import stripe

from stripe_entitlements.annual import AnnualGrantService
from stripe_entitlements.catalog import PlanCatalog
from stripe_entitlements.credit_packs import CreditPackCoordinator
from stripe_entitlements.credits import CreditService
from stripe_entitlements.plan_changes import PlanChangeCoordinator
from stripe_entitlements.processor import EventProcessor
from stripe_entitlements.stripe_gateway import StripeGateway
from tests.credit_helpers import PRO_CREDITS, STARTER_CREDITS, atoms

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


async def _auto_paging_dicts(operation: Any, /, *args: Any, **kwargs: Any) -> list[dict[str, Any]]:
    """Consume every page from a Stripe list operation outside the event loop."""

    def _load() -> list[dict[str, Any]]:
        page = operation(*args, **kwargs)
        return [_dict(item) for item in page.auto_paging_iter()]

    return await asyncio.to_thread(_load)


async def _wait_event(key: str, event_type: str, object_id: str) -> dict[str, Any]:
    __tracebackhide__ = True
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        events = await _auto_paging_dicts(
            stripe.Event.list,
            type=event_type,
            limit=100,
            **_options(key),
        )
        for event in events:
            obj = event.get("data", {}).get("object", {})
            if obj.get("id") == object_id:
                return event
            if event_type == "charge.refunded" and obj.get("invoice") == object_id:
                return event
        await asyncio.sleep(1)
    raise AssertionError(f"Stripe did not expose {event_type} for {object_id}")


async def _wait_charge_refund(
    key: str,
    charge_id: str,
    *,
    amount_refunded: int,
    excluding: set[str] | None = None,
) -> dict[str, Any]:
    """Wait for one cumulative Charge refund fact, not merely any older refund Event."""

    __tracebackhide__ = True
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        events = await _auto_paging_dicts(
            stripe.Event.list,
            type="charge.refunded",
            limit=100,
            **_options(key),
        )
        for event in events:
            if excluding and str(event.get("id")) in excluding:
                continue
            obj = event.get("data", {}).get("object", {})
            if obj.get("id") == charge_id and obj.get("amount_refunded") == amount_refunded:
                return event
        await asyncio.sleep(1)
    raise AssertionError(f"Stripe did not expose charge.refunded={amount_refunded} for {charge_id}")


async def _latest_charge_for_invoice(key: str, invoice_id: str) -> str:
    payments = await _auto_paging_dicts(
        stripe.InvoicePayment.list,
        invoice=invoice_id,
        limit=100,
        **_options(key),
    )
    for raw in payments:
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
        invoices = await _auto_paging_dicts(
            stripe.Invoice.list,
            subscription=subscription_id,
            status="paid",
            limit=100,
            **_options(key),
        )
        for invoice in invoices:
            if excluding and str(invoice.get("id")) in excluding:
                continue
            if billing_reason and invoice.get("billing_reason") != billing_reason:
                continue
            return invoice
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


class _TestClockRecoveryManifest:
    """Atomically retain only non-secret identities needed for interrupted cleanup."""

    def __init__(self, run_id: str) -> None:
        raw_path = os.getenv("TEST_CLOCK_RECOVERY_MANIFEST", "").strip()
        self.path = Path(raw_path) if raw_path else None
        self.state: dict[str, Any] = {
            "schema_version": 1,
            "run_id": run_id,
            "stripe_api_version": STRIPE_API_VERSION,
            "secret_free": True,
            "status": "initialized",
        }
        self.update()

    def update(self, **values: Any) -> None:
        self.state.update(values)
        self.state["updated_at_unix"] = int(time.time())
        if self.path is None:
            return
        temporary = self.path.with_name(f".{self.path.name}.{uuid.uuid4().hex}.tmp")
        descriptor: int | None = None
        try:
            descriptor = os.open(
                temporary,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                0o600,
            )
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                descriptor = None
                json.dump(self.state, handle, sort_keys=True)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.path)
            self.path.chmod(0o600)
        finally:
            if descriptor is not None:
                os.close(descriptor)
            temporary.unlink(missing_ok=True)

    def remove(self) -> None:
        if self.path is not None:
            self.path.unlink(missing_ok=True)


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


async def _zero_run_owned_pack_payment(
    errors: list[str],
    key: str,
    *,
    run_id: str,
    account_id: str,
    order_id: str,
    payment_intent: Any,
    expected_metadata: dict[str, str],
    expected_amount: int,
    expected_currency: str,
) -> None:
    """Refund only a positively identified run-owned pack Charge and verify zero cash."""

    if payment_intent is None:
        return
    try:
        intent = _dict(
            await asyncio.to_thread(
                stripe.PaymentIntent.retrieve,
                payment_intent.id,
                **_options(key),
            )
        )
        metadata = intent.get("metadata") or {}
        charge_id = str(intent.get("latest_charge") or "")
        if (
            bool(intent.get("livemode"))
            or metadata != expected_metadata
            or intent.get("status") != "succeeded"
            or intent.get("amount") != expected_amount
            or intent.get("amount_received") != expected_amount
            or intent.get("currency") != expected_currency
            or not charge_id.startswith("ch_")
        ):
            errors.append("pack_payment_intent:ownership_mismatch")
            return
        charge = _dict(
            await asyncio.to_thread(
                stripe.Charge.retrieve,
                charge_id,
                **_options(key),
            )
        )
        amount = charge.get("amount")
        amount_refunded = charge.get("amount_refunded")
        if (
            bool(charge.get("livemode"))
            or charge.get("payment_intent") != intent.get("id")
            or charge.get("customer") != intent.get("customer")
            or type(amount) is not int
            or type(amount_refunded) is not int
            or amount <= 0
            or amount != expected_amount
            or amount_refunded < 0
            or amount_refunded > amount
            or charge.get("currency") != expected_currency
        ):
            errors.append("pack_charge:ownership_mismatch")
            return
        if amount_refunded < amount:
            await asyncio.to_thread(
                stripe.Refund.create,
                charge=charge_id,
                amount=amount - amount_refunded,
                metadata={
                    "automated_test": "true",
                    "run_id": run_id,
                    "credit_pack_order_id": order_id,
                },
                **_create_options(key, run_id, "pack-cleanup-refund"),
            )
        final_charge = _dict(
            await asyncio.to_thread(
                stripe.Charge.retrieve,
                charge_id,
                **_options(key),
            )
        )
        if (
            final_charge.get("payment_intent") != intent.get("id")
            or final_charge.get("amount_refunded") != final_charge.get("amount")
            or not bool(final_charge.get("refunded"))
        ):
            errors.append("pack_charge:refundable_inventory_remaining")
    except stripe.StripeError as exc:
        errors.append(f"pack_payment_cleanup:{type(exc).__name__}")


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


async def _inventory_page(
    errors: list[str],
    label: str,
    operation: Any,
    /,
    *args: Any,
    **kwargs: Any,
) -> list[dict[str, Any]]:
    try:
        return await _auto_paging_dicts(operation, *args, **kwargs)
    except stripe.StripeError as exc:
        errors.append(f"{label}_inventory:{type(exc).__name__}")
        return []


async def _run_inventory(
    errors: list[str], key: str, run_id: str, *, phase: str
) -> dict[str, list[dict[str, Any]]]:
    subscriptions = [
        raw
        for raw in await _inventory_page(
            errors,
            f"{phase}_subscription",
            stripe.Subscription.list,
            status="all",
            limit=100,
            **_options(key),
        )
        if (raw.get("metadata") or {}).get("run_id") == run_id
    ]
    subscription_ids = {str(raw["id"]) for raw in subscriptions}
    schedules = []
    for raw in await _inventory_page(
        errors,
        f"{phase}_schedule",
        stripe.SubscriptionSchedule.list,
        limit=100,
        **_options(key),
    ):
        subscription = raw.get("subscription")
        subscription_id = (
            str(subscription.get("id"))
            if isinstance(subscription, dict)
            else str(subscription or "")
        )
        product_line = str((raw.get("metadata") or {}).get("product_line") or "")
        if subscription_id in subscription_ids or run_id in product_line:
            schedules.append(raw)
    customers = [
        raw
        for raw in await _inventory_page(
            errors,
            f"{phase}_customer",
            stripe.Customer.list,
            limit=100,
            **_options(key),
        )
        if (raw.get("metadata") or {}).get("run_id") == run_id
    ]
    prices = [
        raw
        for raw in await _inventory_page(
            errors,
            f"{phase}_price",
            stripe.Price.list,
            limit=100,
            **_options(key),
        )
        if (raw.get("metadata") or {}).get("run_id") == run_id
    ]
    products = [
        raw
        for raw in await _inventory_page(
            errors,
            f"{phase}_product",
            stripe.Product.list,
            limit=100,
            **_options(key),
        )
        if (raw.get("metadata") or {}).get("run_id") == run_id
    ]
    clocks = [
        raw
        for raw in await _inventory_page(
            errors,
            f"{phase}_test_clock",
            stripe.test_helpers.TestClock.list,
            limit=100,
            **_options(key),
        )
        if raw.get("name") == f"stripe-entitlements-annual-{run_id}"
    ]
    return {
        "subscriptions": subscriptions,
        "schedules": schedules,
        "customers": customers,
        "prices": prices,
        "products": products,
        "test_clocks": clocks,
    }


async def _assert_run_inventory_empty(errors: list[str], key: str, run_id: str) -> None:
    inventory = await _run_inventory(errors, key, run_id, phase="post_cleanup")
    residual_counts = {
        "subscriptions": sum(raw.get("status") != "canceled" for raw in inventory["subscriptions"]),
        "customers": len(inventory["customers"]),
        "active_prices": sum(bool(raw.get("active")) for raw in inventory["prices"]),
        "active_products": sum(bool(raw.get("active")) for raw in inventory["products"]),
        "test_clocks": len(inventory["test_clocks"]),
        "unfinished_schedules": sum(
            raw.get("status") not in {"released", "canceled", "completed"}
            for raw in inventory["schedules"]
        ),
    }
    for label, count in residual_counts.items():
        if count:
            errors.append(f"post_cleanup_{label}_remaining:{count}")


async def _sweep_run_objects(errors: list[str], key: str, run_id: str) -> None:
    inventory = await _run_inventory(errors, key, run_id, phase="sweep")
    for raw in inventory["schedules"]:
        if raw.get("status") not in {"released", "canceled", "completed"}:
            await _cleanup_call(
                errors,
                "swept_subscription_schedule",
                stripe.SubscriptionSchedule.release,
                raw["id"],
                **_options(key),
            )
    for raw in inventory["subscriptions"]:
        if raw.get("status") != "canceled":
            await _cleanup_call(
                errors,
                "swept_subscription",
                stripe.Subscription.delete,
                raw["id"],
                **_options(key),
            )
    for raw in inventory["customers"]:
        await _cleanup_call(
            errors,
            "swept_customer",
            stripe.Customer.delete,
            raw["id"],
            **_options(key),
        )
    for resource, label in ((stripe.Price, "price"), (stripe.Product, "product")):
        for raw in inventory[f"{label}s"]:
            if bool(raw.get("active")):
                await _cleanup_call(
                    errors,
                    f"swept_{label}",
                    resource.modify,
                    raw["id"],
                    active=False,
                    **_options(key),
                )
    for raw in inventory["test_clocks"]:
        await _cleanup_call(
            errors,
            "swept_test_clock",
            stripe.test_helpers.TestClock.delete,
            raw["id"],
            **_options(key),
        )
    await _assert_run_inventory_empty(errors, key, run_id)


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
        invoices = await _auto_paging_dicts(
            stripe.Invoice.list,
            subscription=subscription.id,
            status="paid",
            limit=100,
            **_options(key),
        )
        assert invoices
        invoice_id = str(invoices[0]["id"])
        paid_event = await _wait_event(key, "invoice.paid", invoice_id)
        observed_event_version = str(paid_event.get("api_version") or "")
        assert observed_event_version
        gateway = StripeGateway(key, "whsec_not_used", product_line, api_version=STRIPE_API_VERSION)
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
        assert paid_result.outcome == "handled", paid_result
        async with pool.acquire() as conn:
            assert (
                await conn.fetchval(
                    "select credits_balance from billing_accounts where id=$1::uuid", account_id
                )
                == STARTER_CREDITS
            )

        charge_id = await _latest_charge_for_invoice(key, invoice_id)
        await asyncio.to_thread(stripe.Refund.create, charge=charge_id, amount=950, **_options(key))
        refund_event = await _wait_event(key, "charge.refunded", charge_id)
        prepared_refund = await gateway.prepare_event(refund_event)
        refund_result = await processor.process(prepared_refund)
        assert refund_result.outcome == "handled"
        async with pool.acquire() as conn:
            assert await conn.fetchval(
                "select credits_balance from billing_accounts where id=$1::uuid", account_id
            ) == atoms(150)
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


async def test_real_credit_pack_payment_cash_clawback_and_product_refund_converge(
    pool: asyncpg.Pool, catalog: PlanCatalog, make_account
) -> None:
    """Exercise one real pack payment while keeping every business effect in PostgreSQL."""

    key = _test_key()
    run_id = uuid.uuid4().hex[:12]
    cleanup_errors: list[str] = []
    prefix = f"p{run_id}"
    product_line = f"stripe-entitlements-pack-real-{run_id}"
    account_id = await make_account(customer=None, subscription=None)
    real_catalog = PlanCatalog(
        catalog.plans,
        prefix,
        credit_packs=catalog.credit_packs,
    )
    pack = real_catalog.require_credit_pack("boost-100")
    product = None
    price = None
    customer = None
    payment_intent = None
    order_id = ""
    expected_payment_metadata: dict[str, str] = {}
    try:
        product = await asyncio.to_thread(
            stripe.Product.create,
            name=f"Stripe Entitlements credit-pack real test {run_id}",
            metadata={
                "automated_test": "true",
                "run_id": run_id,
                "product_line": product_line,
                "credit_pack": pack.key,
            },
            **_create_options(key, run_id, "pack-product"),
        )
        price = await asyncio.to_thread(
            stripe.Price.create,
            product=product.id,
            currency=pack.currency,
            unit_amount=pack.price_usd * 100,
            lookup_key=real_catalog.credit_pack_lookup_key(pack.key),
            metadata={
                "automated_test": "true",
                "run_id": run_id,
                "product_line": product_line,
                "credit_pack": pack.key,
            },
            **_create_options(key, run_id, "pack-price"),
        )
        price_raw = _dict(price)
        assert price_raw.get("type") == "one_time"
        assert price_raw.get("recurring") is None
        assert price_raw.get("currency") == pack.currency
        assert price_raw.get("unit_amount") == pack.price_usd * 100
        assert price_raw.get("lookup_key") == real_catalog.credit_pack_lookup_key(pack.key)

        customer = await asyncio.to_thread(
            stripe.Customer.create,
            name=f"Automated credit-pack test {run_id}",
            metadata={
                "automated_test": "true",
                "run_id": run_id,
                "account_id": account_id,
            },
            **_create_options(key, run_id, "pack-customer"),
        )
        reservation = await CreditPackCoordinator(pool, real_catalog).reserve(
            account_id,
            pack,
            f"real-pack-{run_id}",
        )
        order_id = reservation.order_id
        metadata = {
            "automated_test": "true",
            "run_id": run_id,
            "billing_kind": "credit_pack",
            "pack_schema_version": "1",
            "product_line": product_line,
            "credit_pack_order_id": order_id,
            "account_id": account_id,
            "pack_key": pack.key,
            "pack_credits": str(pack.credits),
            "price_amount": str(pack.price_usd * 100),
            "currency": pack.currency,
            "expires_days": str(pack.expires_days),
            "lookup_key": real_catalog.credit_pack_lookup_key(pack.key),
        }
        expected_payment_metadata = metadata
        payment_method = await asyncio.to_thread(
            stripe.PaymentMethod.attach,
            "pm_card_visa",
            customer=customer.id,
            **_options(key),
        )
        payment_intent = await asyncio.to_thread(
            stripe.PaymentIntent.create,
            amount=pack.price_usd * 100,
            currency=pack.currency,
            customer=customer.id,
            payment_method=payment_method.id,
            payment_method_types=["card"],
            confirm=True,
            off_session=True,
            description=f"Run-scoped Boost 100 test {run_id}",
            metadata=metadata,
            **_create_options(key, run_id, "pack-payment-intent"),
        )
        intent_raw = _dict(payment_intent)
        charge_id = str(intent_raw.get("latest_charge") or "")
        assert intent_raw.get("status") == "succeeded"
        assert intent_raw.get("amount") == pack.price_usd * 100
        assert intent_raw.get("amount_received") == pack.price_usd * 100
        assert intent_raw.get("currency") == pack.currency
        assert intent_raw.get("customer") == customer.id
        assert intent_raw.get("metadata") == metadata
        assert charge_id.startswith("ch_")

        paid_event = await _wait_event(key, "payment_intent.succeeded", payment_intent.id)
        paid_object = paid_event.get("data", {}).get("object", {})
        assert paid_object.get("id") == payment_intent.id
        assert paid_object.get("metadata") == metadata
        assert paid_object.get("amount_received") == pack.price_usd * 100
        assert paid_object.get("currency") == pack.currency
        assert paid_object.get("customer") == customer.id
        assert paid_object.get("latest_charge") == charge_id
        observed_event_version = str(paid_event.get("api_version") or "")
        assert observed_event_version
        gateway = StripeGateway(key, "whsec_not_used", product_line, api_version=STRIPE_API_VERSION)
        processor = EventProcessor(
            pool,
            real_catalog,
            product_line,
            expected_api_version=observed_event_version,
        )
        paid_result = await processor.process(await gateway.prepare_event(paid_event))
        assert paid_result.outcome == "handled", paid_result

        service = CreditService(pool)
        charged = await service.charge(account_id, "80", f"real-pack-job-{run_id}")
        assert charged.outcome == "charged"
        assert charged.balance_atoms == atoms(20)

        await asyncio.to_thread(
            stripe.Refund.create,
            charge=charge_id,
            amount=750,
            metadata={
                "automated_test": "true",
                "run_id": run_id,
                "credit_pack_order_id": order_id,
            },
            **_create_options(key, run_id, "pack-partial-refund"),
        )
        partial_event = await _wait_charge_refund(key, charge_id, amount_refunded=750)
        assert partial_event.get("api_version") == observed_event_version
        partial_result = await processor.process(await gateway.prepare_event(partial_event))
        assert partial_result.outcome == "handled", partial_result
        async with pool.acquire() as conn:
            partial = await conn.fetchrow(
                """select o.amount_paid,o.amount_refunded,o.refunded_credits,o.payment_status,
                          l.remaining_credits,l.cash_clawed_back_credits,l.status,
                          d.target_credits,d.collected_credits,d.released_credits
                     from credit_pack_orders o
                     join credit_funding_lots l on l.order_id=o.id
                     left join credit_pack_clawback_debts d on d.order_id=o.id
                    where o.id=$1::uuid""",
                order_id,
            )
        assert partial is not None
        assert tuple(partial) == (
            1500,
            750,
            atoms(50),
            "partially_refunded",
            0,
            atoms(20),
            "active",
            atoms(30),
            0,
            0,
        )

        product_refund = await service.refund(
            f"real-pack-job-{run_id}",
            expected_account_id=account_id,
        )
        assert product_refund.outcome == "refunded"
        assert product_refund.requested_atoms == atoms(80)
        assert product_refund.restored_atoms == atoms(50)
        assert product_refund.balance_atoms == atoms(50)
        replayed_product_refund = await service.refund(
            f"real-pack-job-{run_id}",
            expected_account_id=account_id,
        )
        assert replayed_product_refund.outcome == "replayed"
        assert replayed_product_refund.requested_atoms == atoms(80)
        assert replayed_product_refund.restored_atoms == atoms(50)
        assert replayed_product_refund.balance_atoms == atoms(50)

        await asyncio.to_thread(
            stripe.Refund.create,
            charge=charge_id,
            amount=750,
            metadata={
                "automated_test": "true",
                "run_id": run_id,
                "credit_pack_order_id": order_id,
            },
            **_create_options(key, run_id, "pack-full-refund"),
        )
        full_event = await _wait_charge_refund(
            key,
            charge_id,
            amount_refunded=1500,
            excluding={str(partial_event["id"])},
        )
        assert full_event.get("api_version") == observed_event_version
        full_result = await processor.process(await gateway.prepare_event(full_event))
        assert full_result.outcome == "handled", full_result

        final_charge = _dict(
            await asyncio.to_thread(stripe.Charge.retrieve, charge_id, **_options(key))
        )
        assert final_charge.get("amount_refunded") == final_charge.get("amount") == 1500
        assert bool(final_charge.get("refunded"))
        async with pool.acquire() as conn:
            final = await conn.fetchrow(
                """select o.stripe_payment_intent_id,o.stripe_charge_id,
                          o.stripe_customer_id,o.amount_paid,o.amount_refunded,
                          o.refunded_credits,o.payment_status,
                          l.original_credits,l.remaining_credits,
                          l.cash_clawed_back_credits,l.status,
                          d.target_credits,d.collected_credits,d.released_credits,
                          u.amount,u.restored_credits,u.refunded_at is not null
                     from credit_pack_orders o
                     join credit_funding_lots l on l.order_id=o.id
                     join credit_debits u on u.idempotency_key=$2
                     left join credit_pack_clawback_debts d on d.order_id=o.id
                    where o.id=$1::uuid""",
                order_id,
                f"real-pack-job-{run_id}",
            )
        assert final is not None
        assert tuple(final) == (
            payment_intent.id,
            charge_id,
            customer.id,
            1500,
            1500,
            atoms(100),
            "refunded",
            atoms(100),
            0,
            atoms(70),
            "refunded",
            atoms(30),
            0,
            atoms(30),
            atoms(80),
            atoms(50),
            True,
        )
    finally:
        if order_id:
            await _zero_run_owned_pack_payment(
                cleanup_errors,
                key,
                run_id=run_id,
                account_id=account_id,
                order_id=order_id,
                payment_intent=payment_intent,
                expected_metadata=expected_payment_metadata,
                expected_amount=pack.price_usd * 100,
                expected_currency=pack.currency,
            )
        await _cleanup_standard_objects(
            cleanup_errors,
            key,
            subscription=None,
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

        gateway = StripeGateway(key, "whsec_not_used", product_line, api_version=STRIPE_API_VERSION)
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
        assert tuple(account) == ("pro", "month", PRO_CREDITS)
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


async def test_real_prorated_delta_upgrade_and_refund_preserve_funding_lineage(
    pool: asyncpg.Pool, catalog: PlanCatalog, make_account
) -> None:
    key = _test_key()
    run_id = uuid.uuid4().hex[:12]
    cleanup_errors: list[str] = []
    prefix = f"d{run_id}"
    product_line = f"stripe-entitlements-delta-{run_id}"
    account_id = await make_account(customer=None, subscription=None)
    product = None
    starter_price = None
    pro_price = None
    customer = None
    subscription = None
    try:
        product = await asyncio.to_thread(
            stripe.Product.create,
            name=f"Stripe Entitlements delta test {run_id}",
            metadata={"automated_test": "true", "run_id": run_id},
            **_create_options(key, run_id, "delta-product"),
        )
        starter_price = await asyncio.to_thread(
            stripe.Price.create,
            product=product.id,
            currency="usd",
            unit_amount=1900,
            recurring={"interval": "month"},
            lookup_key=f"{prefix}_starter_month",
            metadata={"automated_test": "true", "run_id": run_id},
            **_create_options(key, run_id, "delta-starter-price"),
        )
        pro_price = await asyncio.to_thread(
            stripe.Price.create,
            product=product.id,
            currency="usd",
            unit_amount=4900,
            recurring={"interval": "month"},
            lookup_key=f"{prefix}_pro_month",
            metadata={"automated_test": "true", "run_id": run_id},
            **_create_options(key, run_id, "delta-pro-price"),
        )
        customer = await asyncio.to_thread(
            stripe.Customer.create,
            name=f"Automated delta test {run_id}",
            metadata={
                "automated_test": "true",
                "run_id": run_id,
                "account_id": account_id,
            },
            **_create_options(key, run_id, "delta-customer"),
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
            **_create_options(key, run_id, "delta-subscription"),
        )
        async with pool.acquire() as conn:
            await conn.execute(
                """update billing_accounts set stripe_customer_id=$2,
                     stripe_subscription_id=$3 where id=$1::uuid""",
                account_id,
                customer.id,
                subscription.id,
            )
        initial_invoices = await _auto_paging_dicts(
            stripe.Invoice.list,
            subscription=subscription.id,
            status="paid",
            limit=100,
            **_options(key),
        )
        assert initial_invoices
        initial_invoice_id = str(initial_invoices[0]["id"])
        initial_event = await _wait_event(key, "invoice.paid", initial_invoice_id)
        observed_event_version = str(initial_event.get("api_version") or "")
        assert observed_event_version
        gateway = StripeGateway(key, "whsec_not_used", product_line, api_version=STRIPE_API_VERSION)
        real_catalog = PlanCatalog(catalog.plans, prefix)
        processor = EventProcessor(
            pool,
            real_catalog,
            product_line,
            expected_api_version=observed_event_version,
        )
        initial_result = await processor.process(await gateway.prepare_event(initial_event))
        assert initial_result.outcome == "handled", initial_result

        coordinator = PlanChangeCoordinator(
            pool,
            real_catalog,
            gateway,
            transition_policy="prorated_delta",
        )
        preview = await coordinator.preview_remote(
            account_id, "pro", "month", f"real-delta-{run_id}"
        )
        assert preview.decision.timing == "immediate"
        assert preview.transition_policy == "prorated_delta"
        assert preview.entitlement_credit_delta == PRO_CREDITS - STARTER_CREDITS
        assert preview.estimated_amount_due is not None
        assert preview.estimated_amount_due > 0
        assert preview.estimated_credit_applied is not None
        assert preview.estimated_credit_applied > 0

        confirmed = await coordinator.confirm(account_id, preview.change_id)
        assert confirmed.status == "applied"
        updated = _dict(
            await asyncio.to_thread(stripe.Subscription.retrieve, subscription.id, **_options(key))
        )
        latest_invoice = updated.get("latest_invoice")
        upgrade_invoice_id = (
            str(latest_invoice.get("id"))
            if isinstance(latest_invoice, dict)
            else str(latest_invoice)
        )
        assert upgrade_invoice_id not in {"", "None", initial_invoice_id}
        upgrade_event = await _wait_event(key, "invoice.paid", upgrade_invoice_id)
        processed = await processor.process(await gateway.prepare_event(upgrade_event))
        assert processed.outcome == "handled"
        async with pool.acquire() as conn:
            account = await conn.fetchrow(
                """select plan_key,plan_interval,credits_balance,grant_epoch,
                          entitlement_revoked from billing_accounts where id=$1::uuid""",
                account_id,
            )
            allocation = await conn.fetchrow(
                """select * from billing_funding_allocations
                     where stripe_invoice_id=$1""",
                upgrade_invoice_id,
            )
        assert account is not None and allocation is not None
        assert tuple(account) == ("pro", "month", PRO_CREDITS, 1, False)
        assert allocation["source_invoice_id"] == initial_invoice_id
        assert allocation["entitlement_delta"] == PRO_CREDITS - STARTER_CREDITS
        assert allocation["amount_paid"] == preview.estimated_amount_due

        charge_id = await _latest_charge_for_invoice(key, upgrade_invoice_id)
        await asyncio.to_thread(
            stripe.Refund.create,
            charge=charge_id,
            **_create_options(key, run_id, "delta-full-refund"),
        )
        refund_event = await _wait_event(key, "charge.refunded", charge_id)
        refund_result = await processor.process(await gateway.prepare_event(refund_event))
        assert refund_result.outcome == "handled"
        async with pool.acquire() as conn:
            reverted = await conn.fetchrow(
                """select plan_key,plan_interval,credits_balance,grant_epoch,
                          entitlement_revoked from billing_accounts where id=$1::uuid""",
                account_id,
            )
            allocation_status = await conn.fetchrow(
                """select status,refunded_units from billing_funding_allocations
                     where stripe_invoice_id=$1""",
                upgrade_invoice_id,
            )
        assert reverted is not None and allocation_status is not None
        assert tuple(reverted) == ("starter", "month", STARTER_CREDITS, 2, False)
        assert tuple(allocation_status) == (
            "closed",
            PRO_CREDITS - STARTER_CREDITS,
        )
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
@pytest.mark.parametrize("transition_policy", ["full_period_reset", "prorated_delta"])
async def test_real_failed_immediate_change_keeps_old_entitlement(
    failure_payment_method: str,
    transition_policy: str,
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
                     stripe_subscription_id=$3 where id=$1::uuid""",
                account_id,
                customer.id,
                subscription.id,
            )

        gateway = StripeGateway(key, "whsec_not_used", product_line, api_version=STRIPE_API_VERSION)
        real_catalog = PlanCatalog(catalog.plans, prefix)
        initial_invoice = await _wait_paid_invoice(key, subscription.id)
        initial_event = await _wait_event(key, "invoice.paid", str(initial_invoice["id"]))
        observed_event_version = str(initial_event.get("api_version") or "")
        assert observed_event_version
        processor = EventProcessor(
            pool,
            real_catalog,
            product_line,
            expected_api_version=observed_event_version,
        )
        initial_result = await processor.process(await gateway.prepare_event(initial_event))
        assert initial_result.outcome == "handled"
        coordinator = PlanChangeCoordinator(
            pool,
            real_catalog,
            gateway,
            transition_policy=transition_policy,  # type: ignore[arg-type]
        )
        preview = await coordinator.preview_remote(
            account_id, "pro", "month", f"real-failed-change-{run_id}"
        )
        assert preview.decision.timing == "immediate"
        assert preview.transition_policy == transition_policy
        if transition_policy == "prorated_delta":
            assert preview.estimated_amount_due is not None
            assert preview.estimated_amount_due > 0
            assert preview.estimated_credit_applied is not None
            assert preview.estimated_credit_applied > 0
            assert preview.entitlement_credit_delta == PRO_CREDITS - STARTER_CREDITS
        else:
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
            str(current_price.get("id")) if isinstance(current_price, dict) else str(current_price)
        )
        assert current_price_id == starter_price.id
        invoice = remote_raw.get("latest_invoice") or {}
        assert isinstance(invoice, dict) and invoice.get("status") == "open"
        failure_event = await _wait_event(key, "invoice.payment_failed", str(invoice["id"]))
        assert failure_event.get("api_version") == observed_event_version
        failure_result = await processor.process(await gateway.prepare_event(failure_event))
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
            allocation_count = await conn.fetchval(
                """select count(*) from billing_funding_allocations
                     where account_id=$1::uuid""",
                account_id,
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
            STARTER_CREDITS,
            1,
            False,
            period_end,
            period_end,
        )
        assert account["credit_expires_at"] > datetime.now(UTC)
        assert stored is not None
        assert (stored["status"], stored["transition_policy"]) == (
            "requires_action",
            transition_policy,
        )
        assert ledger_count == 1
        assert allocation_count == 0
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

        gateway = StripeGateway(key, "whsec_not_used", product_line, api_version=STRIPE_API_VERSION)
        coordinator = PlanChangeCoordinator(pool, PlanCatalog(catalog.plans, prefix), gateway)
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
            str(target_price.get("id")) if isinstance(target_price, dict) else str(target_price)
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
    recovery_manifest = _TestClockRecoveryManifest(run_id)
    cleanup_errors: list[str] = []
    body_succeeded = False
    prefix = f"c{run_id}"
    product_line = f"stripe-entitlements-clock-{run_id}"
    account_id = await make_account(customer=None, subscription=None)
    recovery_manifest.update(status="creating", account_id=account_id)
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
        recovery_manifest.update(test_clock_id=str(clock.id))
        product = await asyncio.to_thread(
            stripe.Product.create,
            name=f"Stripe Entitlements annual clock test {run_id}",
            metadata={"automated_test": "true", "run_id": run_id},
            **_create_options(key, run_id, "product"),
        )
        recovery_manifest.update(product_id=str(product.id))
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
        recovery_manifest.update(annual_price_id=str(annual_price.id))
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
        recovery_manifest.update(customer_id=str(customer.id))
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
        recovery_manifest.update(subscription_id=str(subscription.id), status="running")
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
        recovery_manifest.update(initial_invoice_id=initial_invoice_id)
        initial_event = await _wait_event(key, "invoice.paid", initial_invoice_id)
        observed_event_version = str(initial_event.get("api_version") or "")
        assert observed_event_version
        real_catalog = PlanCatalog(catalog.plans, prefix)
        gateway = StripeGateway(key, "whsec_not_used", product_line, api_version=STRIPE_API_VERSION)
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
            STARTER_CREDITS,
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
        assert tuple(first_month_account)[:5] == (
            "active",
            STARTER_CREDITS,
            2,
            2,
            False,
        )
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
        downtime_result = await service.grant_due(account_id, downtime_now, downtime_snapshot)
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
            STARTER_CREDITS,
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
        recovery_manifest.update(renewal_invoice_id=renewal_invoice_id)
        renewal_event = await _wait_event(key, "invoice.paid", renewal_invoice_id)
        assert renewal_event.get("api_version") == observed_event_version
        renewal_result = await processor.process(await gateway.prepare_event(renewal_event))
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
            STARTER_CREDITS,
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
        recovery_manifest.update(status="assertions_passed")
        body_succeeded = True
    finally:
        try:
            recovery_manifest.update(status="cleanup_started")
        except OSError as exc:
            cleanup_errors.append(f"recovery_manifest:{type(exc).__name__}")
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
        if cleanup_errors:
            try:
                recovery_manifest.update(status="cleanup_failed", cleanup_errors=cleanup_errors)
            except OSError as exc:
                cleanup_errors.append(f"recovery_manifest_cleanup_failure:{type(exc).__name__}")
        _assert_cleanup(cleanup_errors)
        if body_succeeded:
            recovery_manifest.remove()
        else:
            recovery_manifest.update(status="test_failed_cleanup_succeeded")
