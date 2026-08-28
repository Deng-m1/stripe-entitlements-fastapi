from __future__ import annotations

import asyncio
import copy
import json
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any, cast
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import stripe

from .checkout import CheckoutCreationRejected
from .config import (
    checkout_success_base_url_is_safe,
    public_http_url_is_structurally_safe,
)
from .invoice_policy import has_unsupported_invoice_adjustments
from .plan_changes import (
    PlanChangeContext,
    PlanChangeEstimate,
    RemotePlanChange,
)
from .portal_policy import portal_configuration_is_safe
from .price_policy import catalog_one_time_price_matches, catalog_price_matches
from .transitions import BillingInterval, TransitionPolicy
from .types import SubscriptionSnapshot


class _UnsupportedStripeShape(RuntimeError):
    pass


_SUBSCRIPTION_STATUSES = {
    "active",
    "canceled",
    "incomplete",
    "incomplete_expired",
    "past_due",
    "paused",
    "trialing",
    "unpaid",
}


def _stripe_integer(value: Any) -> int | None:
    return value if type(value) is int else None


def _required_text(value: Any, *, field: str, max_bytes: int = 2048) -> str:
    if (
        not isinstance(value, str)
        or not value
        or value != value.strip()
        or len(value.encode("utf-8")) > max_bytes
        or any(not character.isprintable() for character in value)
    ):
        raise RuntimeError(f"Stripe returned an invalid {field}")
    return value


def _required_https_url(value: Any, *, field: str) -> str:
    url = _required_text(value, field=field)
    parsed = urlsplit(url)
    if (
        parsed.scheme != "https"
        or not parsed.netloc
        or parsed.username is not None
        or parsed.password is not None
    ):
        raise RuntimeError(f"Stripe returned a non-HTTPS {field}")
    return url


def _strip_untrusted_internal_fields(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {
            str(key): _strip_untrusted_internal_fields(item)
            for key, item in value.items()
            if not str(key).startswith("_")
        }
    if isinstance(value, list):
        return [_strip_untrusted_internal_fields(item) for item in value]
    return value


def _stripe_object_dict(value: Any) -> dict[str, Any]:
    if isinstance(value, Mapping):
        return dict(value)
    to_dict = getattr(value, "to_dict_recursive", None)
    if callable(to_dict):
        converted = to_dict()
        if isinstance(converted, Mapping):
            return dict(converted)
    try:
        parsed = json.loads(str(value))
    except (TypeError, ValueError):
        namespace = getattr(value, "__dict__", None)
        if isinstance(namespace, Mapping):
            return dict(namespace)
        raise RuntimeError("Stripe returned an object that cannot be serialized safely") from None
    if not isinstance(parsed, Mapping):
        raise RuntimeError("Stripe returned a non-object response")
    return dict(parsed)


class StripeGateway:
    def __init__(
        self,
        secret_key: str,
        webhook_secret: str,
        product_line: str = "example-entitlements",
        *,
        api_version: str = "2026-06-24.dahlia",
        portal_configuration_id: str | None = None,
        checkout_success_url: str = "http://localhost:3000/billing/success",
        checkout_cancel_url: str = "http://localhost:3000/pricing",
        portal_return_url: str = "http://localhost:3000/account",
    ) -> None:
        if not secret_key.startswith(("sk_test_", "sk_live_")):
            raise ValueError("Stripe secret key must be an sk_test_ or sk_live_ key")
        if not webhook_secret.startswith("whsec_"):
            raise ValueError("Stripe webhook secret must start with whsec_")
        for field, value in (
            ("checkout_success_url", checkout_success_url),
            ("checkout_cancel_url", checkout_cancel_url),
            ("portal_return_url", portal_return_url),
        ):
            if not public_http_url_is_structurally_safe(value):
                raise ValueError(f"{field} must be an origin-safe HTTP(S) URL")
        if not checkout_success_base_url_is_safe(checkout_success_url):
            raise ValueError("checkout_success_url must not include a query or fragment")
        self.secret_key = secret_key
        self.webhook_secret = webhook_secret
        self.product_line = product_line
        self.api_version = api_version
        self.portal_configuration_id = portal_configuration_id
        self.checkout_success_url = checkout_success_url
        self.checkout_cancel_url = checkout_cancel_url
        self.portal_return_url = portal_return_url

    @property
    def _request_options(self) -> dict[str, Any]:
        return {"api_key": self.secret_key, "stripe_version": self.api_version}

    def construct_event(self, payload: bytes, signature: str) -> dict[str, Any]:
        event = stripe.Webhook.construct_event(  # type: ignore[no-untyped-call]
            payload, signature, self.webhook_secret
        )
        parsed = _strip_untrusted_internal_fields(_stripe_object_dict(event))
        if not isinstance(parsed, dict):
            raise RuntimeError("Stripe returned a non-object Event")
        return parsed

    async def prepare_event(self, event: dict[str, Any]) -> dict[str, Any]:
        """Resolve mutable/network references before opening a DB transaction."""
        prepared = copy.deepcopy(event)
        event_type = prepared.get("type")
        data = prepared.get("data")
        if not isinstance(data, Mapping):
            return prepared
        obj = data.get("object")
        if not isinstance(obj, dict) or not self._object_id(obj.get("id")):
            return prepared
        if event_type == "invoice.paid":
            await self._prepare_invoice_lines(obj)
            invoice_id = self._object_id(obj.get("id"))
            if invoice_id and await self._unsupported_invoice_payment_collection(invoice_id):
                obj["_unsupported_invoice_payment_shape"] = True
        elif event_type == "customer.subscription.updated":
            items = obj.get("items")
            raw_items = items.get("data") if isinstance(items, Mapping) else None
            if isinstance(raw_items, list):
                await self._resolve_lookups(raw_items)
        elif event_type in {"charge.refunded", "charge.dispute.created"}:
            if event_type == "charge.dispute.created":
                charge_id = obj.get("charge")
                if not charge_id:
                    return prepared
                charge_object = await asyncio.to_thread(
                    stripe.Charge.retrieve, charge_id, **self._request_options
                )
                charge = _stripe_object_dict(charge_object)
                obj["_resolved_charge"] = charge
            else:
                charge = obj
            invoice_id = self._object_id(charge.get("invoice"))
            payment_intent_id = self._object_id(charge.get("payment_intent"))
            if payment_intent_id:
                payment_intent_object = await asyncio.to_thread(
                    stripe.PaymentIntent.retrieve,
                    payment_intent_id,
                    **self._request_options,
                )
                payment_intent = _stripe_object_dict(payment_intent_object)
                if self._object_id(payment_intent.get("id")) != payment_intent_id:
                    raise RuntimeError("Stripe returned a conflicting PaymentIntent identity")
                obj["_resolved_payment_intent"] = payment_intent
                payment_metadata = payment_intent.get("metadata")
                if (
                    not invoice_id
                    and isinstance(payment_metadata, Mapping)
                    and payment_metadata.get("billing_kind") == "credit_pack"
                ):
                    return prepared
            if not invoice_id and payment_intent_id:
                payments = await asyncio.to_thread(
                    stripe.InvoicePayment.list,
                    payment={
                        "type": "payment_intent",
                        "payment_intent": payment_intent_id,
                    },
                    limit=2,
                    **self._request_options,
                )
                raw_payments = getattr(payments, "data", None)
                has_more = getattr(payments, "has_more", None)
                if not isinstance(raw_payments, list) or not isinstance(has_more, bool):
                    raise RuntimeError("Stripe returned an invalid InvoicePayment collection")
                if has_more or len(raw_payments) > 1:
                    obj["_unsupported_invoice_payment_shape"] = True
                    return prepared
                if not raw_payments:
                    raise RuntimeError("Stripe has not exposed the InvoicePayment mapping yet")
                payment = _stripe_object_dict(raw_payments[0])
                payment_details = payment.get("payment")
                if (
                    not isinstance(payment_details, Mapping)
                    or payment_details.get("type") != "payment_intent"
                    or self._object_id(payment_details.get("payment_intent")) != payment_intent_id
                ):
                    raise RuntimeError("Stripe returned a conflicting InvoicePayment mapping")
                invoice_id = self._object_id(payment.get("invoice"))
                if not invoice_id:
                    raise RuntimeError("Stripe InvoicePayment mapping has no Invoice identity")
            if invoice_id:
                obj["_resolved_invoice_id"] = invoice_id
                if await self._unsupported_invoice_payment_collection(
                    invoice_id,
                    expected_payment_intent_id=payment_intent_id,
                ):
                    obj["_unsupported_invoice_payment_shape"] = True
        return prepared

    async def _unsupported_invoice_payment_collection(
        self,
        invoice_id: str,
        *,
        expected_payment_intent_id: str | None = None,
    ) -> bool:
        payments = await asyncio.to_thread(
            stripe.InvoicePayment.list,
            invoice=invoice_id,
            status="paid",
            limit=2,
            **self._request_options,
        )
        raw_payments = getattr(payments, "data", None)
        has_more = getattr(payments, "has_more", None)
        if not isinstance(raw_payments, list) or not isinstance(has_more, bool):
            raise RuntimeError("Stripe returned an invalid InvoicePayment collection")
        if has_more or len(raw_payments) > 1:
            return True
        if not raw_payments:
            raise RuntimeError("Stripe has not exposed the InvoicePayment mapping yet")
        payment = _stripe_object_dict(raw_payments[0])
        payment_id = self._object_id(payment.get("id"))
        mapped_invoice_id = self._object_id(payment.get("invoice"))
        details = payment.get("payment")
        if mapped_invoice_id is not None and mapped_invoice_id != invoice_id:
            raise RuntimeError("Stripe returned a conflicting InvoicePayment mapping")
        if not isinstance(details, Mapping):
            return True
        payment_intent_id = self._object_id(details.get("payment_intent"))
        if (
            payment_id is None
            or mapped_invoice_id is None
            or payment.get("status") != "paid"
            or details.get("type") != "payment_intent"
            or payment_intent_id is None
        ):
            return True
        if (
            expected_payment_intent_id is not None
            and payment_intent_id != expected_payment_intent_id
        ):
            raise RuntimeError("Stripe returned a conflicting InvoicePayment payment identity")

        return False

    async def _prepare_invoice_lines(self, invoice: dict[str, Any]) -> None:
        """Materialize the complete Invoice line collection before DB processing."""
        container = invoice.get("lines")
        if not isinstance(container, Mapping):
            return
        raw_lines = container.get("data")
        if not isinstance(raw_lines, list):
            return
        lines = list(raw_lines)
        if container.get("has_more"):
            invoice_id = self._object_id(invoice.get("id"))
            if not invoice_id:
                return
            try:
                lines = await self._list_invoice_lines(invoice_id)
            except _UnsupportedStripeShape as exc:
                invoice["_preparation_error"] = str(exc)
                invoice["lines"] = {
                    **dict(container),
                    "has_more": True,
                    "_all_lines_loaded": False,
                }
                return
        await self._resolve_lookups(lines)
        invoice["lines"] = {
            **dict(container),
            "data": lines,
            "has_more": False,
            "_all_lines_loaded": True,
        }

    async def _list_invoice_lines(self, invoice_id: str) -> list[dict[str, Any]]:
        lines: list[dict[str, Any]] = []
        seen_line_ids: set[str] = set()
        starting_after: str | None = None
        while True:
            params: dict[str, Any] = {"invoice": invoice_id, "limit": 100}
            if starting_after:
                params["starting_after"] = starting_after
            page = await asyncio.to_thread(
                stripe.Invoice.list_lines,
                invoice_id,
                **{key: value for key, value in params.items() if key != "invoice"},
                **self._request_options,
            )
            raw_page_lines = getattr(page, "data", None)
            has_more = getattr(page, "has_more", None)
            if not isinstance(raw_page_lines, list) or not isinstance(has_more, bool):
                raise _UnsupportedStripeShape("Stripe Invoice line page has an invalid shape")
            page_lines: list[dict[str, Any]] = []
            for raw_line in raw_page_lines:
                try:
                    line = _stripe_object_dict(raw_line)
                except (RuntimeError, TypeError, ValueError) as exc:
                    raise _UnsupportedStripeShape(
                        "Stripe Invoice line page contains a non-object line"
                    ) from exc
                line_id = self._object_id(line.get("id"))
                if line_id is None or line_id in seen_line_ids:
                    raise _UnsupportedStripeShape(
                        "Stripe Invoice line pagination contains missing or duplicate identity"
                    )
                seen_line_ids.add(line_id)
                page_lines.append(line)
            lines.extend(page_lines)
            if len(lines) > 1000:
                raise _UnsupportedStripeShape("Invoice has more than the supported 1000 lines")
            if not has_more:
                return lines
            if not page_lines:
                raise _UnsupportedStripeShape("Stripe Invoice line pagination did not advance")
            next_cursor = self._object_id(page_lines[-1].get("id"))
            if next_cursor is None or next_cursor == starting_after:
                raise _UnsupportedStripeShape("Stripe Invoice line pagination did not advance")
            starting_after = next_cursor

    _catalog_price_matches = staticmethod(catalog_price_matches)

    @staticmethod
    def _object_id(value: Any) -> str | None:
        candidate = value.get("id") if isinstance(value, Mapping) else value
        if (
            not isinstance(candidate, str)
            or not candidate
            or candidate != candidate.strip()
            or len(candidate.encode("utf-8")) > 512
            or any(not character.isprintable() for character in candidate)
        ):
            return None
        return candidate

    @classmethod
    def _invoice_subscription_id(cls, invoice: Mapping[str, Any]) -> str | None:
        direct = cls._object_id(invoice.get("subscription"))
        if direct:
            return direct
        parent = invoice.get("parent")
        details = parent.get("subscription_details") if isinstance(parent, Mapping) else None
        return cls._object_id(details.get("subscription")) if isinstance(details, Mapping) else None

    async def _resolve_lookups(self, lines: list[Any]) -> None:
        unresolved: dict[str, list[dict[str, Any]]] = {}
        for line in lines:
            if not isinstance(line, dict):
                continue
            resolved_price = line.get("_resolved_price")
            if isinstance(resolved_price, Mapping):
                lookup = resolved_price.get("lookup_key")
                if lookup:
                    line["_resolved_lookup_key"] = str(lookup)
                continue
            price_id = self._price_id(line)
            if price_id:
                unresolved.setdefault(price_id, []).append(line)
        if not unresolved:
            return
        semaphore = asyncio.Semaphore(8)

        async def _retrieve(price_id: str) -> tuple[str, dict[str, Any]]:
            async with semaphore:
                price = await asyncio.to_thread(
                    stripe.Price.retrieve,
                    price_id,
                    expand=["product", "currency_options"],
                    **self._request_options,
                )
            return price_id, _stripe_object_dict(price)

        resolved = await asyncio.gather(*(_retrieve(price_id) for price_id in unresolved))
        for price_id, price in resolved:
            lookup = price.get("lookup_key")
            for line in unresolved[price_id]:
                line["_resolved_price"] = price
                line["_resolved_lookup_key"] = str(lookup) if lookup else None

    @staticmethod
    def _inline_lookup(line: Mapping[str, Any]) -> str | None:
        price = line.get("price")
        if isinstance(price, Mapping) and price.get("lookup_key"):
            return str(price["lookup_key"])
        return None

    @staticmethod
    def _price_id(line: Mapping[str, Any]) -> str | None:
        price = line.get("price")
        if isinstance(price, str):
            return price
        if isinstance(price, Mapping) and price.get("id"):
            return str(price["id"])
        pricing = line.get("pricing")
        details = pricing.get("price_details") if isinstance(pricing, Mapping) else None
        if isinstance(details, Mapping) and details.get("price"):
            return str(details["price"])
        return None

    async def subscription_snapshot(self, subscription_id: str) -> SubscriptionSnapshot:
        subscription = await self.subscription_object(subscription_id)
        container = subscription.get("items")
        raw_items = container.get("data") if isinstance(container, Mapping) else None
        if (
            isinstance(container, Mapping)
            and container.get("has_more") in {None, False}
            and isinstance(raw_items, list)
            and len(raw_items) == 1
            and isinstance(raw_items[0], Mapping)
        ):
            item: Mapping[str, Any] = raw_items[0]
            items_complete = True
        else:
            item = {}
            items_complete = False
        lookup = self._inline_lookup(item) if item else None
        lookup = lookup or (item.get("_resolved_lookup_key") if item else None)
        period_end_raw = item.get("current_period_end", subscription.get("current_period_end"))
        period_end_value = _stripe_integer(period_end_raw)
        try:
            period_end = (
                datetime.fromtimestamp(period_end_value, tz=UTC)
                if period_end_value is not None
                else None
            )
        except (ValueError, OverflowError, OSError):
            period_end = None
        resolved_price = item.get("_resolved_price") if item else None
        quantity = _stripe_integer(item.get("quantity")) if item else None
        status = subscription.get("status")
        return SubscriptionSnapshot(
            subscription_id,
            status if isinstance(status, str) else "",
            lookup,
            period_end,
            dict(resolved_price) if isinstance(resolved_price, Mapping) else None,
            quantity,
            items_complete,
        )

    async def subscription_object(
        self, subscription_id: str, *, expand: list[str] | None = None
    ) -> dict[str, Any]:
        options: dict[str, Any] = dict(self._request_options)
        if expand:
            options["expand"] = expand
        subscription = _stripe_object_dict(
            await asyncio.to_thread(
                stripe.Subscription.retrieve,
                subscription_id,
                **options,
            )
        )
        if self._object_id(subscription.get("id")) != subscription_id:
            raise RuntimeError("Stripe returned a different Subscription identity")
        livemode = subscription.get("livemode")
        if not isinstance(livemode, bool) or livemode != self.secret_key.startswith("sk_live_"):
            raise RuntimeError("Stripe Subscription mode does not match the configured key")
        container = subscription.get("items")
        raw_items = container.get("data") if isinstance(container, Mapping) else None
        if isinstance(raw_items, list):
            await self._resolve_lookups(raw_items)
        return subscription

    async def checkout_session_object(self, session_id: str) -> dict[str, Any]:
        """Retrieve one Checkout Session for transaction-free reconciliation."""

        session_id = _required_text(session_id, field="Checkout Session id", max_bytes=255)
        if not session_id.startswith("cs_"):
            raise ValueError("Checkout Session id must start with cs_")
        session = _stripe_object_dict(
            await asyncio.to_thread(
                stripe.checkout.Session.retrieve,
                session_id,
                **self._request_options,
            )
        )
        if self._object_id(session.get("id")) != session_id:
            raise RuntimeError("Stripe returned a different Checkout Session identity")
        livemode = session.get("livemode")
        if not isinstance(livemode, bool) or livemode != self.secret_key.startswith("sk_live_"):
            raise RuntimeError("Stripe Checkout Session mode does not match the configured key")
        return session

    async def payment_intent_object(self, payment_intent_id: str) -> dict[str, Any]:
        """Retrieve one PaymentIntent for transaction-free reconciliation."""

        payment_intent_id = _required_text(
            payment_intent_id, field="PaymentIntent id", max_bytes=255
        )
        if not payment_intent_id.startswith("pi_"):
            raise ValueError("PaymentIntent id must start with pi_")
        payment_intent = _stripe_object_dict(
            await asyncio.to_thread(
                stripe.PaymentIntent.retrieve,
                payment_intent_id,
                **self._request_options,
            )
        )
        if self._object_id(payment_intent.get("id")) != payment_intent_id:
            raise RuntimeError("Stripe returned a different PaymentIntent identity")
        livemode = payment_intent.get("livemode")
        if not isinstance(livemode, bool) or livemode != self.secret_key.startswith("sk_live_"):
            raise RuntimeError("Stripe PaymentIntent mode does not match the configured key")
        return payment_intent

    async def charge_object(self, charge_id: str) -> dict[str, Any]:
        """Retrieve one Charge for refund/dispute reconciliation."""

        charge_id = _required_text(charge_id, field="Charge id", max_bytes=255)
        if not charge_id.startswith("ch_"):
            raise ValueError("Charge id must start with ch_")
        charge = _stripe_object_dict(
            await asyncio.to_thread(
                stripe.Charge.retrieve,
                charge_id,
                **self._request_options,
            )
        )
        if self._object_id(charge.get("id")) != charge_id:
            raise RuntimeError("Stripe returned a different Charge identity")
        livemode = charge.get("livemode")
        if not isinstance(livemode, bool) or livemode != self.secret_key.startswith("sk_live_"):
            raise RuntimeError("Stripe Charge mode does not match the configured key")
        return charge

    async def latest_paid_invoice_event(self, subscription_id: str) -> dict[str, Any] | None:
        invoices = await asyncio.to_thread(
            stripe.Invoice.list,
            subscription=subscription_id,
            status="paid",
            limit=1,
            **self._request_options,
        )
        raw_invoices = getattr(invoices, "data", None)
        if not isinstance(raw_invoices, list):
            raise RuntimeError("Stripe returned an invalid Invoice collection")
        if not raw_invoices:
            return None
        invoice = _stripe_object_dict(raw_invoices[0])
        invoice_id = self._object_id(invoice.get("id"))
        if invoice_id is None:
            raise RuntimeError("Stripe returned a paid Invoice without stable identity")
        if self._invoice_subscription_id(invoice) != subscription_id:
            raise RuntimeError("Stripe returned a paid Invoice for a different Subscription")
        if invoice.get("status") not in {None, "paid"}:
            raise RuntimeError("Stripe returned an Invoice that is not paid")
        livemode = invoice.get("livemode")
        if not isinstance(livemode, bool) or livemode != self.secret_key.startswith("sk_live_"):
            raise RuntimeError("Stripe paid Invoice mode does not match the configured key")
        transitions = invoice.get("status_transitions")
        paid_at = transitions.get("paid_at") if isinstance(transitions, Mapping) else None
        created = paid_at if _stripe_integer(paid_at) is not None else invoice.get("created")
        created_value = _stripe_integer(created)
        if created_value is None or created_value < 0:
            raise RuntimeError("Stripe paid Invoice has an invalid creation timestamp")
        event = {
            "id": f"reconcile:{invoice_id}",
            "object": "event",
            "type": "invoice.paid",
            "created": created_value,
            "livemode": livemode,
            "_remote_verified": True,
            "data": {"object": invoice},
        }
        return await self.prepare_event(event)

    async def create_checkout_session(
        self,
        *,
        account_id: str,
        customer_id: str | None,
        lookup_key: str,
        expected_currency: str,
        expected_unit_amount: int,
        expected_interval: str,
        claim_token: str,
        expires_at: datetime,
        customer_email: str | None,
        plan_key: str,
        interval: str,
    ) -> tuple[str, str]:
        prices = await asyncio.to_thread(
            stripe.Price.list,
            lookup_keys=[lookup_key],
            active=True,
            limit=2,
            expand=["data.currency_options", "data.product"],
            **self._request_options,
        )
        if len(prices.data) != 1:
            raise CheckoutCreationRejected(
                f"expected exactly one active Stripe price for {lookup_key!r}"
            )
        price_raw = _stripe_object_dict(prices.data[0])
        if not self._catalog_price_matches(
            price_raw,
            expected_currency=expected_currency,
            expected_unit_amount=expected_unit_amount,
            expected_interval=expected_interval,
            expected_product_line=self.product_line,
            expected_plan_key=plan_key,
            expected_lookup_key=lookup_key,
        ):
            raise CheckoutCreationRejected(f"Stripe price {lookup_key!r} drifted from the catalog")
        # Invariant: never add allow_promotion_codes (or any other discount surface) to
        # these params. has_unsupported_invoice_adjustments fails closed on every
        # discounted Invoice, so a redeemed promotion code would mean Stripe collected
        # a discounted payment while this service grants nothing and opens an incident.
        # Promotion-code support is reserved and must not be enabled standalone; it
        # requires an explicit coupon funding policy with its own invoice acceptance.
        params: dict[str, Any] = {
            "mode": "subscription",
            "client_reference_id": account_id,
            "line_items": [{"price": prices.data[0].id, "quantity": 1}],
            "subscription_data": {
                "metadata": {
                    "account_id": account_id,
                    "product_line": self.product_line,
                    "claim_token": claim_token,
                }
            },
            "success_url": self._checkout_success_url(plan_key, interval),
            "cancel_url": self.checkout_cancel_url,
            "expires_at": int(expires_at.timestamp()),
            "metadata": {
                "claim_token": claim_token,
                "account_id": account_id,
                "product_line": self.product_line,
            },
        }
        if customer_id:
            params["customer"] = customer_id
        elif customer_email:
            params["customer_email"] = customer_email

        def _create() -> Any:
            return stripe.checkout.Session.create(
                **params,
                idempotency_key=f"checkout:{account_id}:{claim_token}",
                **self._request_options,
            )

        session = await asyncio.to_thread(
            _create,
        )
        return (
            _required_text(
                getattr(session, "id", None), field="Checkout Session id", max_bytes=255
            ),
            _required_https_url(getattr(session, "url", None), field="Checkout Session URL"),
        )

    async def create_credit_pack_checkout_session(
        self,
        *,
        order_id: str,
        account_id: str,
        customer_id: str | None,
        customer_email: str | None,
        lookup_key: str,
        expected_currency: str,
        expected_unit_amount: int,
        pack_key: str,
        pack_credits: str,
        expires_days: int,
        expires_at: datetime,
    ) -> tuple[str, str]:
        prices = await asyncio.to_thread(
            stripe.Price.list,
            lookup_keys=[lookup_key],
            active=True,
            limit=2,
            expand=["data.currency_options", "data.product"],
            **self._request_options,
        )
        if len(prices.data) != 1:
            raise CheckoutCreationRejected(
                f"expected exactly one active Stripe price for {lookup_key!r}"
            )
        price = _stripe_object_dict(prices.data[0])
        if not catalog_one_time_price_matches(
            price,
            expected_currency=expected_currency,
            expected_unit_amount=expected_unit_amount,
            expected_product_line=self.product_line,
            expected_pack_key=pack_key,
            expected_lookup_key=lookup_key,
        ):
            raise CheckoutCreationRejected(f"Stripe price {lookup_key!r} drifted from the catalog")
        metadata = {
            "billing_kind": "credit_pack",
            "pack_schema_version": "1",
            "product_line": self.product_line,
            "credit_pack_order_id": order_id,
            "account_id": account_id,
            "pack_key": pack_key,
            "pack_credits": pack_credits,
            "price_amount": str(expected_unit_amount),
            "currency": expected_currency,
            "expires_days": str(expires_days),
            "lookup_key": lookup_key,
        }
        success_url = self._credit_pack_success_url(pack_key)
        params: dict[str, Any] = {
            "mode": "payment",
            # The reference pack contract is intentionally card-only. Letting
            # Dashboard automatic payment methods add asynchronous rails would
            # advertise settlement/refund shapes this bounded template does not test.
            "payment_method_types": ["card"],
            "client_reference_id": account_id,
            "line_items": [{"price": prices.data[0].id, "quantity": 1}],
            "payment_intent_data": {"metadata": metadata},
            "success_url": success_url,
            "cancel_url": self.checkout_cancel_url,
            "expires_at": int(expires_at.timestamp()),
            "metadata": metadata,
        }
        if customer_id:
            params["customer"] = customer_id
        else:
            params["customer_creation"] = "always"
            if customer_email:
                params["customer_email"] = customer_email

        def _create() -> Any:
            return stripe.checkout.Session.create(
                **params,
                idempotency_key=f"credit-pack:{order_id}",
                **self._request_options,
            )

        session = await asyncio.to_thread(_create)
        return (
            _required_text(
                getattr(session, "id", None), field="Checkout Session id", max_bytes=255
            ),
            _required_https_url(getattr(session, "url", None), field="Checkout Session URL"),
        )

    def _checkout_success_url(self, plan_key: str, interval: str) -> str:
        split = urlsplit(self.checkout_success_url)
        query = dict(parse_qsl(split.query, keep_blank_values=True))
        query.update(
            {
                "expected_plan": plan_key,
                "expected_interval": interval,
                "checkout_session_id": "{CHECKOUT_SESSION_ID}",
            }
        )
        return urlunsplit(
            (split.scheme, split.netloc, split.path, urlencode(query, safe="{}"), split.fragment)
        )

    def _credit_pack_success_url(self, pack_key: str) -> str:
        split = urlsplit(self.checkout_success_url)
        query = dict(parse_qsl(split.query, keep_blank_values=True))
        query.update(
            {
                "expected_credit_pack": pack_key,
                "checkout_session_id": "{CHECKOUT_SESSION_ID}",
            }
        )
        return urlunsplit(
            (split.scheme, split.netloc, split.path, urlencode(query, safe="{}"), split.fragment)
        )

    async def create_portal_session(
        self, *, customer_id: str, idempotency_key: str
    ) -> tuple[str, str]:
        if not self.portal_configuration_id:
            raise RuntimeError("a dedicated safe Portal configuration is required")
        configuration_id = self.portal_configuration_id
        config = await asyncio.to_thread(
            stripe.billing_portal.Configuration.retrieve,
            configuration_id,
            **self._request_options,
        )
        config_raw = _stripe_object_dict(config)
        if not portal_configuration_is_safe(
            config_raw,
            expected_livemode=self.secret_key.startswith("sk_live_"),
            expected_product_line=self.product_line,
        ):
            raise RuntimeError("Portal configuration drifted from the server safety policy")

        def _create() -> Any:
            return stripe.billing_portal.Session.create(
                customer=customer_id,
                configuration=configuration_id,
                return_url=self.portal_return_url,
                idempotency_key=idempotency_key,
                **self._request_options,
            )

        session = await asyncio.to_thread(_create)
        session_raw = _stripe_object_dict(session)
        session_id = _required_text(session_raw.get("id"), field="Portal Session id", max_bytes=255)
        session_url = _required_https_url(session_raw.get("url"), field="Portal Session URL")
        if (
            not session_id.startswith("bps_")
            or session_raw.get("object") != "billing_portal.session"
            or self._object_id(session_raw.get("customer")) != customer_id
            or self._object_id(session_raw.get("configuration")) != configuration_id
            or session_raw.get("return_url") != self.portal_return_url
            or type(session_raw.get("livemode")) is not bool
            or bool(session_raw.get("livemode")) != self.secret_key.startswith("sk_live_")
        ):
            raise RuntimeError("Stripe returned a Portal Session outside the requested contract")
        return session_id, session_url

    async def prepare_plan_change(
        self,
        subscription_id: str,
        target_lookup_key: str,
        *,
        expected_currency: str,
        expected_unit_amount: int,
        expected_plan_key: str,
        target_interval: BillingInterval,
        expected_source_lookup_key: str,
        expected_source_currency: str,
        expected_source_unit_amount: int,
        expected_source_plan_key: str,
        source_interval: BillingInterval,
    ) -> PlanChangeContext:
        prices = await asyncio.to_thread(
            stripe.Price.list,
            lookup_keys=[target_lookup_key],
            active=True,
            limit=2,
            expand=["data.currency_options", "data.product"],
            **self._request_options,
        )
        if len(prices.data) != 1:
            raise RuntimeError(
                f"expected exactly one active Stripe price for {target_lookup_key!r}"
            )
        target_price = _stripe_object_dict(prices.data[0])
        if not self._catalog_price_matches(
            target_price,
            expected_currency=expected_currency,
            expected_unit_amount=expected_unit_amount,
            expected_interval=target_interval,
            expected_product_line=self.product_line,
            expected_plan_key=expected_plan_key,
            expected_lookup_key=target_lookup_key,
        ):
            raise RuntimeError(f"Stripe price {target_lookup_key!r} drifted from the catalog")
        subscription = await self.subscription_object(
            subscription_id, expand=["latest_invoice.confirmation_secret"]
        )
        container = subscription.get("items")
        raw_items = container.get("data") if isinstance(container, Mapping) else None
        if (
            not isinstance(container, Mapping)
            or container.get("has_more") not in {None, False}
            or not isinstance(raw_items, list)
            or len(raw_items) != 1
            or not isinstance(raw_items[0], Mapping)
        ):
            raise RuntimeError("subscription must contain exactly one item object")
        item = raw_items[0]
        if _stripe_integer(item.get("quantity")) != 1:
            raise RuntimeError("subscription item quantity must be exactly one")
        subscription_item_id = _required_text(
            self._object_id(item.get("id")), field="Subscription item id", max_bytes=255
        )
        current_lookup = self._inline_lookup(item) or item.get("_resolved_lookup_key")
        current_price_id = self._price_id(item)
        current_price = item.get("_resolved_price")
        if (
            not current_lookup
            or not current_price_id
            or not isinstance(current_price, Mapping)
            or not self._catalog_price_matches(
                current_price,
                expected_currency=expected_source_currency,
                expected_unit_amount=expected_source_unit_amount,
                expected_interval=source_interval,
                expected_product_line=self.product_line,
                expected_plan_key=expected_source_plan_key,
                expected_lookup_key=expected_source_lookup_key,
                expected_price_id=current_price_id,
                require_active=False,
            )
        ):
            raise RuntimeError("subscription item Price drifted from the authorized source plan")
        start_value = _stripe_integer(
            item.get("current_period_start", subscription.get("current_period_start"))
        )
        end_value = _stripe_integer(
            item.get("current_period_end", subscription.get("current_period_end"))
        )
        if start_value is None or end_value is None:
            raise RuntimeError("subscription item period must use integer timestamps")
        try:
            period_start = datetime.fromtimestamp(start_value, tz=UTC)
            period_end = datetime.fromtimestamp(end_value, tz=UTC)
        except (ValueError, OverflowError, OSError) as exc:
            raise RuntimeError("subscription item period is outside the supported range") from exc
        if period_end <= period_start:
            raise RuntimeError("subscription item period is invalid")
        schedule_raw = subscription.get("schedule")
        if schedule_raw is None:
            schedule_id = None
        else:
            schedule_id = self._object_id(schedule_raw)
            if schedule_id is None:
                raise RuntimeError("Stripe returned an invalid Subscription Schedule identity")
        status = subscription.get("status")
        if not isinstance(status, str) or status not in _SUBSCRIPTION_STATUSES:
            raise RuntimeError("Stripe returned an unsupported Subscription status")
        cancel_at_period_end = subscription.get("cancel_at_period_end")
        if not isinstance(cancel_at_period_end, bool):
            raise RuntimeError("Stripe returned an invalid cancel_at_period_end value")
        pending_raw = subscription.get("pending_update")
        if pending_raw is None:
            pending: Mapping[str, Any] = {}
        elif isinstance(pending_raw, Mapping):
            pending = pending_raw
        else:
            raise RuntimeError("Stripe returned an invalid pending_update shape")
        pending_expires_raw = pending.get("expires_at")
        pending_expires_value = (
            _stripe_integer(pending_expires_raw) if pending_expires_raw is not None else None
        )
        if pending and pending_expires_value is None:
            raise RuntimeError("Stripe pending_update is missing an integer expiry")
        try:
            pending_expires_at = (
                datetime.fromtimestamp(pending_expires_value, tz=UTC)
                if pending_expires_value is not None
                else None
            )
        except (ValueError, OverflowError, OSError) as exc:
            raise RuntimeError("Stripe returned an invalid pending_update expiry") from exc
        latest = subscription.get("latest_invoice")
        if latest is None:
            latest_invoice: Mapping[str, Any] = {}
        elif isinstance(latest, Mapping):
            latest_invoice = latest
        else:
            raise RuntimeError("Stripe did not expand the latest Invoice")
        confirmation_raw = latest_invoice.get("confirmation_secret")
        if confirmation_raw is None:
            confirmation: Mapping[str, Any] = {}
        elif isinstance(confirmation_raw, Mapping):
            confirmation = confirmation_raw
        else:
            raise RuntimeError("Stripe returned an invalid confirmation_secret shape")
        client_secret_raw = confirmation.get("client_secret")
        client_secret = (
            _required_text(client_secret_raw, field="payment client secret", max_bytes=512)
            if client_secret_raw is not None
            else None
        )
        recovery_raw = latest_invoice.get("hosted_invoice_url")
        recovery_url = (
            _required_https_url(recovery_raw, field="hosted Invoice URL")
            if recovery_raw is not None
            else None
        )
        target_price_id = _required_text(
            self._object_id(target_price.get("id")), field="target Price id", max_bytes=255
        )
        return PlanChangeContext(
            subscription_id,
            subscription_item_id,
            current_price_id,
            str(current_lookup),
            target_price_id,
            target_interval,
            period_start,
            period_end,
            schedule_id,
            status,
            cancel_at_period_end,
            bool(pending),
            pending_expires_at,
            recovery_url,
            client_secret,
        )

    async def preview_immediate_plan_change(
        self,
        context: PlanChangeContext,
        *,
        policy: TransitionPolicy = "full_period_reset",
        proration_date: int | None = None,
    ) -> PlanChangeEstimate:
        subscription_details: dict[str, Any] = {
            "items": [
                {
                    "id": context.subscription_item_id,
                    "price": context.target_price_id,
                }
            ]
        }
        if policy == "full_period_reset":
            subscription_details.update(
                {"billing_cycle_anchor": "now", "proration_behavior": "none"}
            )
        else:
            if proration_date is None:
                raise RuntimeError("prorated_delta requires a fixed proration_date")
            subscription_details.update(
                {
                    "proration_behavior": "always_invoice",
                    "proration_date": proration_date,
                }
            )
        preview = await asyncio.to_thread(
            stripe.Invoice.create_preview,
            subscription=context.subscription_id,
            subscription_details=cast(Any, subscription_details),
            **self._request_options,
        )
        raw = _stripe_object_dict(preview)
        container = raw.get("lines")
        raw_lines = container.get("data") if isinstance(container, Mapping) else None
        valid_line_collection = bool(
            isinstance(raw_lines, list) and all(isinstance(line, Mapping) for line in raw_lines)
        )
        lines = cast(list[Mapping[str, Any]], raw_lines) if valid_line_collection else []
        has_more = bool(
            not valid_line_collection
            or not isinstance(container, Mapping)
            or container.get("has_more")
        )
        invoice_currency = str(raw.get("currency") or "").lower()
        total_value = _stripe_integer(raw.get("total"))
        amount_due_value = _stripe_integer(raw.get("amount_due"))
        subtotal_value = _stripe_integer(raw.get("subtotal"))
        numeric_totals_valid = all(
            value is not None for value in (total_value, amount_due_value, subtotal_value)
        )
        total = total_value if total_value is not None else 0
        amount_due = amount_due_value if amount_due_value is not None else 0
        subtotal = subtotal_value if subtotal_value is not None else 0
        target_non_proration = [
            line
            for line in lines
            if not self._line_is_proration(line) and self._price_id(line) == context.target_price_id
        ]
        starting_balance_value = (
            0 if "starting_balance" not in raw else _stripe_integer(raw.get("starting_balance"))
        )
        ending_balance_value = (
            0 if "ending_balance" not in raw else _stripe_integer(raw.get("ending_balance"))
        )
        starting_balance = starting_balance_value if starting_balance_value is not None else 0
        ending_balance = ending_balance_value if ending_balance_value is not None else 0
        proration_credit = sum(
            -amount
            for line in lines
            if self._line_is_proration(line)
            and (amount := _stripe_integer(line.get("amount"))) is not None
            and amount < 0
        )
        source_prorations = [
            line
            for line in lines
            if self._line_is_proration(line)
            and self._price_id(line) == context.current_price_id
            and (amount := _stripe_integer(line.get("amount"))) is not None
            and amount < 0
        ]
        target_prorations = [
            line
            for line in lines
            if self._line_is_proration(line)
            and self._price_id(line) == context.target_price_id
            and (amount := _stripe_integer(line.get("amount"))) is not None
            and amount > 0
        ]

        def _array(value: Any) -> list[Any]:
            return list(value) if isinstance(value, list) else []

        def _sum_integer_amounts(items: list[Any]) -> int:
            return sum(
                amount
                for item in items
                if isinstance(item, Mapping)
                and (amount := _stripe_integer(item.get("amount"))) is not None
            )

        tax_items = _array(raw.get("total_tax_amounts")) + _array(raw.get("total_taxes"))
        for line in lines:
            tax_items.extend(_array(line.get("tax_amounts")))
            tax_items.extend(_array(line.get("taxes")))
        tax_amount = _sum_integer_amounts(tax_items)
        discount_items = _array(raw.get("total_discount_amounts"))
        unsupported_line_adjustment = False
        for line in lines:
            discount_items.extend(_array(line.get("discount_amounts")))
            for item in _array(line.get("pretax_credit_amounts")):
                if isinstance(item, Mapping):
                    amount = _stripe_integer(item.get("amount"))
                    if amount is None or amount != 0:
                        unsupported_line_adjustment = True
        discount_amount = _sum_integer_amounts(discount_items)
        if raw.get("discounts") and discount_amount == 0:
            discount_amount = 1
        pre_credit_notes = (
            0
            if "pre_payment_credit_notes_amount" not in raw
            else _stripe_integer(raw.get("pre_payment_credit_notes_amount"))
        )
        post_credit_notes = (
            0
            if "post_payment_credit_notes_amount" not in raw
            else _stripe_integer(raw.get("post_payment_credit_notes_amount"))
        )
        balance_fields = (
            starting_balance_value,
            ending_balance_value,
            pre_credit_notes,
            post_credit_notes,
        )
        common_safe = bool(
            not has_more
            and numeric_totals_valid
            and all(value == 0 for value in balance_fields)
            and tax_amount == 0
            and discount_amount == 0
            and not unsupported_line_adjustment
            and not has_unsupported_invoice_adjustments(raw, lines)
        )
        period_start: datetime | None = None
        period_end: datetime | None = None
        source_proration_amount = 0
        target_proration_amount = 0
        if policy == "prorated_delta":
            if len(source_prorations) == 1 and len(target_prorations) == 1:
                source_period = source_prorations[0].get("period")
                target_period = target_prorations[0].get("period")
                if (
                    isinstance(source_period, Mapping)
                    and isinstance(target_period, Mapping)
                    and source_period == target_period
                ):
                    start_value = _stripe_integer(target_period.get("start"))
                    end_value = _stripe_integer(target_period.get("end"))
                    try:
                        period_start = (
                            datetime.fromtimestamp(start_value, tz=UTC)
                            if start_value is not None
                            else None
                        )
                        period_end = (
                            datetime.fromtimestamp(end_value, tz=UTC)
                            if end_value is not None
                            else None
                        )
                    except (ValueError, OverflowError, OSError):
                        period_start = None
                        period_end = None
            source_amount_value = (
                _stripe_integer(source_prorations[0].get("amount"))
                if len(source_prorations) == 1
                else None
            )
            target_amount_value = (
                _stripe_integer(target_prorations[0].get("amount"))
                if len(target_prorations) == 1
                else None
            )
            source_proration_amount = source_amount_value if source_amount_value is not None else 0
            target_proration_amount = target_amount_value if target_amount_value is not None else 0
            safe_shape = bool(
                common_safe
                and len(lines) == 2
                and len(source_prorations) == 1
                and len(target_prorations) == 1
                and all(isinstance(line.get("id"), str) and line.get("id") for line in lines)
                and all(_stripe_integer(line.get("quantity")) == 1 for line in lines)
                and source_amount_value is not None
                and target_amount_value is not None
                and source_proration_amount < 0
                and target_proration_amount > -source_proration_amount > 0
                and source_proration_amount + target_proration_amount == total
                and total == amount_due == subtotal
                and bool(invoice_currency)
                and all(
                    str(line.get("currency") or invoice_currency).lower() == invoice_currency
                    for line in lines
                )
                and period_start is not None
                and period_end is not None
                and period_end > period_start
                and int(period_start.timestamp()) == proration_date
                and period_end == context.current_period_end
            )
        else:
            target_line = target_non_proration[0] if len(target_non_proration) == 1 else {}
            target_period = target_line.get("period")
            target_start = (
                _stripe_integer(target_period.get("start"))
                if isinstance(target_period, Mapping)
                else None
            )
            target_end = (
                _stripe_integer(target_period.get("end"))
                if isinstance(target_period, Mapping)
                else None
            )
            try:
                full_period_start = (
                    datetime.fromtimestamp(target_start, tz=UTC)
                    if target_start is not None
                    else None
                )
                full_period_end = (
                    datetime.fromtimestamp(target_end, tz=UTC) if target_end is not None else None
                )
                valid_full_period = bool(
                    full_period_start is not None
                    and full_period_end is not None
                    and full_period_end > full_period_start
                )
            except (ValueError, OverflowError, OSError):
                valid_full_period = False
            target_quantity = _stripe_integer(target_line.get("quantity"))
            full_target_amount = _stripe_integer(target_line.get("amount"))
            safe_shape = bool(
                common_safe
                and len(lines) == 1
                and len(target_non_proration) == 1
                and isinstance(target_line.get("id"), str)
                and target_line.get("id")
                and target_quantity == 1
                and full_target_amount is not None
                and full_target_amount > 0
                and full_target_amount == total == amount_due == subtotal
                and str(target_line.get("currency") or invoice_currency).lower() == invoice_currency
                and bool(invoice_currency)
                and valid_full_period
            )
        return PlanChangeEstimate(
            amount_due,
            proration_credit,
            max(-starting_balance, -ending_balance, 0),
            str(raw.get("currency") or "usd"),
            safe_shape,
            -source_proration_amount,
            target_proration_amount,
            tax_amount,
            discount_amount,
            period_start,
            period_end,
        )

    async def apply_immediate_plan_change(
        self,
        context: PlanChangeContext,
        *,
        idempotency_key: str,
        policy: TransitionPolicy = "full_period_reset",
        proration_date: int | None = None,
    ) -> RemotePlanChange:
        settlement: dict[str, Any]
        if policy == "full_period_reset":
            settlement = {
                "billing_cycle_anchor": "now",
                "proration_behavior": "none",
            }
        else:
            if proration_date is None:
                raise RuntimeError("prorated_delta requires a fixed proration_date")
            settlement = {
                "proration_behavior": "always_invoice",
                "proration_date": proration_date,
            }

        def _modify() -> Any:
            return stripe.Subscription.modify(
                context.subscription_id,
                items=[
                    {
                        "id": context.subscription_item_id,
                        "price": context.target_price_id,
                    }
                ],
                **settlement,
                payment_behavior="pending_if_incomplete",
                expand=["latest_invoice.confirmation_secret"],
                idempotency_key=idempotency_key,
                **self._request_options,
            )

        subscription = _stripe_object_dict(await asyncio.to_thread(_modify))
        returned_subscription_id = self._object_id(subscription.get("id"))
        if returned_subscription_id != context.subscription_id:
            raise RuntimeError("Stripe returned a different Subscription after plan mutation")
        livemode = subscription.get("livemode")
        if not isinstance(livemode, bool) or livemode != self.secret_key.startswith("sk_live_"):
            raise RuntimeError("Stripe plan mutation mode does not match the configured key")
        status = subscription.get("status")
        if not isinstance(status, str) or status not in _SUBSCRIPTION_STATUSES:
            raise RuntimeError("Stripe plan mutation returned an unsupported Subscription status")
        pending_raw = subscription.get("pending_update")
        if pending_raw is None:
            pending: Mapping[str, Any] = {}
        elif isinstance(pending_raw, Mapping):
            pending = pending_raw
        else:
            raise RuntimeError("Stripe returned an invalid pending_update shape")
        latest_invoice = subscription.get("latest_invoice")
        if not isinstance(latest_invoice, Mapping):
            raise RuntimeError("Stripe plan mutation did not return an expanded latest Invoice")
        invoice = latest_invoice
        settlement_invoice_id = self._object_id(invoice)
        if settlement_invoice_id is None:
            raise RuntimeError("Stripe plan mutation returned an Invoice without identity")
        confirmation_raw = invoice.get("confirmation_secret")
        if confirmation_raw is None:
            confirmation: Mapping[str, Any] = {}
        elif isinstance(confirmation_raw, Mapping):
            confirmation = confirmation_raw
        else:
            raise RuntimeError("Stripe returned an invalid confirmation_secret shape")
        client_secret_raw = confirmation.get("client_secret")
        client_secret = (
            _required_text(client_secret_raw, field="payment client secret", max_bytes=512)
            if client_secret_raw is not None
            else None
        )
        expires_raw = pending.get("expires_at")
        expires = _stripe_integer(expires_raw) if expires_raw is not None else None
        if expires_raw is not None and expires is None:
            raise RuntimeError("Stripe returned an invalid pending_update expiry")
        if pending and expires is None:
            raise RuntimeError("Stripe pending_update is missing an integer expiry")
        try:
            pending_expires_at = (
                datetime.fromtimestamp(expires, tz=UTC) if expires is not None else None
            )
        except (ValueError, OverflowError, OSError) as exc:
            raise RuntimeError("Stripe returned an invalid pending_update expiry") from exc
        recovery_raw = invoice.get("hosted_invoice_url")
        recovery_url = (
            _required_https_url(recovery_raw, field="hosted Invoice URL")
            if recovery_raw is not None
            else None
        )
        pending_active = bool(pending)
        return RemotePlanChange(
            returned_subscription_id,
            pending_active,
            pending_expires_at if pending_active else None,
            recovery_url if pending_active else None,
            client_secret if pending_active else None,
            settlement_invoice_id,
        )

    async def schedule_plan_change(
        self,
        context: PlanChangeContext,
        *,
        idempotency_key: str,
    ) -> RemotePlanChange:
        # Stripe rejects all additional create fields with from_subscription. Metadata
        # and the complete phase policy are applied only in the second idempotent call.
        schedule = await asyncio.to_thread(
            stripe.SubscriptionSchedule.create,
            from_subscription=context.subscription_id,
            idempotency_key=f"{idempotency_key}:create",
            **self._request_options,
        )
        schedule_raw = _stripe_object_dict(schedule)
        schedule_id = _required_text(
            self._object_id(schedule_raw.get("id")), field="Subscription Schedule id", max_bytes=255
        )
        if context.schedule_id and schedule_id != context.schedule_id:
            raise RuntimeError("subscription is controlled by an unrelated Stripe Schedule")
        raw_phases = schedule_raw.get("phases")
        phases = raw_phases if isinstance(raw_phases, list) else []
        if len(phases) == 2:
            if not self._configured_schedule_matches(schedule_raw, context, idempotency_key):
                raise RuntimeError("existing Stripe Schedule differs from this plan change")
            return RemotePlanChange(schedule_id)
        if len(phases) != 1:
            raise RuntimeError("new subscription schedule must contain one current phase")
        if not isinstance(phases[0], Mapping):
            raise RuntimeError("new Subscription Schedule phase must be an object")
        current_phase = self._schedule_phase_payload(phases[0])
        current_phase["end_date"] = int(context.current_period_end.timestamp())
        target_phase = copy.deepcopy(current_phase)
        target_phase["start_date"] = int(context.current_period_end.timestamp())
        target_phase.pop("end_date", None)
        target_phase["items"] = [{"price": context.target_price_id, "quantity": 1}]
        target_phase["duration"] = {
            "interval": context.target_interval,
            "interval_count": 1,
        }
        current_phase["proration_behavior"] = "none"
        target_phase["proration_behavior"] = "none"

        def _configure() -> Any:
            return stripe.SubscriptionSchedule.modify(
                schedule_id,
                phases=cast(Any, [current_phase, target_phase]),
                end_behavior="release",
                proration_behavior="none",
                metadata={
                    "product_line": self.product_line,
                    "plan_change_key": idempotency_key,
                },
                idempotency_key=f"{idempotency_key}:configure",
                **self._request_options,
            )

        configured = await asyncio.to_thread(_configure)
        configured_raw = _stripe_object_dict(configured)
        configured_id = _required_text(
            self._object_id(configured_raw.get("id")),
            field="configured Subscription Schedule id",
            max_bytes=255,
        )
        if configured_id != schedule_id:
            raise RuntimeError("Stripe configured a different Subscription Schedule")
        verified = await asyncio.to_thread(
            stripe.SubscriptionSchedule.retrieve,
            configured_id,
            **self._request_options,
        )
        verified_raw = _stripe_object_dict(verified)
        if self._object_id(
            verified_raw.get("id")
        ) != configured_id or not self._configured_schedule_matches(
            verified_raw, context, idempotency_key
        ):
            raise RuntimeError("configured Stripe Schedule failed policy verification")
        return RemotePlanChange(configured_id)

    @staticmethod
    def _phase_duration_matches(
        phase: Mapping[str, Any], *, boundary: int, interval: BillingInterval
    ) -> bool:
        duration = phase.get("duration")
        if isinstance(duration, Mapping):
            return duration == {"interval": interval, "interval_count": 1}
        end_date = _stripe_integer(phase.get("end_date"))
        if end_date is None:
            return False
        start = datetime.fromtimestamp(boundary, tz=UTC)
        if interval == "month":
            year = start.year + (1 if start.month == 12 else 0)
            month = 1 if start.month == 12 else start.month + 1
        else:
            year = start.year + 1
            month = start.month
        day = start.day
        while True:
            try:
                expected = start.replace(year=year, month=month, day=day)
                break
            except ValueError:
                day -= 1
        return end_date == int(expected.timestamp())

    def _configured_schedule_matches(
        self,
        schedule: Mapping[str, Any],
        context: PlanChangeContext,
        plan_change_key: str,
    ) -> bool:
        raw_phases = schedule.get("phases")
        if (
            not isinstance(raw_phases, list)
            or len(raw_phases) != 2
            or not all(isinstance(phase, Mapping) for phase in raw_phases)
        ):
            return False
        phases = raw_phases
        metadata = schedule.get("metadata")
        if not isinstance(metadata, Mapping):
            return False
        subscription_id = self._object_id(schedule.get("subscription"))
        current_raw_items = phases[0].get("items")
        target_raw_items = phases[1].get("items")
        if not isinstance(current_raw_items, list) or not isinstance(target_raw_items, list):
            return False
        current_items = current_raw_items
        target_items = target_raw_items
        if not all(isinstance(item, Mapping) for item in current_items + target_items):
            return False
        boundary = int(context.current_period_end.timestamp())
        return bool(
            subscription_id == context.subscription_id
            and schedule.get("end_behavior") == "release"
            and metadata.get("product_line") == self.product_line
            and metadata.get("plan_change_key") == plan_change_key
            and phases[0].get("end_date") == boundary
            and phases[1].get("start_date") == boundary
            and self._phase_duration_matches(
                phases[1], boundary=boundary, interval=context.target_interval
            )
            and phases[0].get("proration_behavior") == "none"
            and phases[1].get("proration_behavior") == "none"
            and len(current_items) == 1
            and len(target_items) == 1
            and self._price_id(current_items[0]) == context.current_price_id
            and self._price_id(target_items[0]) == context.target_price_id
            and _stripe_integer(current_items[0].get("quantity")) == 1
            and _stripe_integer(target_items[0].get("quantity")) == 1
        )

    @staticmethod
    def _line_is_proration(line: Mapping[str, Any]) -> bool:
        if line.get("proration"):
            return True
        parent = line.get("parent")
        if not isinstance(parent, Mapping):
            return False
        details = parent.get("subscription_item_details")
        return bool(details.get("proration")) if isinstance(details, Mapping) else False

    @staticmethod
    def _schedule_phase_payload(phase: Mapping[str, Any]) -> dict[str, Any]:
        # Keep every mutable current-phase field Stripe returned; omit identifiers and
        # computed fields rejected by modify. This prevents tax/collection/transfer
        # policy from silently disappearing at schedule creation.
        allowed = {
            "application_fee_percent",
            "automatic_tax",
            "billing_cycle_anchor",
            "collection_method",
            "currency",
            "default_payment_method",
            "default_tax_rates",
            "description",
            "discounts",
            "end_date",
            "invoice_settings",
            "items",
            "metadata",
            "on_behalf_of",
            "proration_behavior",
            "start_date",
            "transfer_data",
            "trial_end",
        }
        payload = {key: copy.deepcopy(value) for key, value in phase.items() if key in allowed}
        raw_items = payload.get("items")
        if not isinstance(raw_items, list) or len(raw_items) != 1:
            raise RuntimeError("schedule phase must contain exactly one item")
        items: list[dict[str, Any]] = []
        for item in raw_items:
            if not isinstance(item, Mapping):
                raise RuntimeError("schedule phase item must be an object")
            price_id = StripeGateway._price_id(item)
            if not price_id or _stripe_integer(item.get("quantity")) != 1:
                raise RuntimeError("schedule phase item must have one resolvable Price")
            items.append({"price": price_id, "quantity": 1})
        payload["items"] = items
        return payload
