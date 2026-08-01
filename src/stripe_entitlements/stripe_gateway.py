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
from .plan_changes import (
    PlanChangeContext,
    PlanChangeEstimate,
    RemotePlanChange,
)
from .portal_policy import portal_configuration_is_safe
from .transitions import BillingInterval, TransitionPolicy
from .types import SubscriptionSnapshot


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
        parsed: dict[str, Any] = json.loads(str(event))
        return parsed

    async def prepare_event(self, event: dict[str, Any]) -> dict[str, Any]:
        """Resolve mutable/network references before opening a DB transaction."""
        prepared = copy.deepcopy(event)
        event_type = prepared.get("type")
        obj = prepared.get("data", {}).get("object", {})
        if event_type in {"invoice.paid", "invoice.payment_failed"}:
            await self._prepare_invoice_lines(obj)
        elif event_type in {
            "customer.subscription.updated",
            "customer.subscription.deleted",
        }:
            await self._resolve_lookups((obj.get("items") or {}).get("data") or [])
        elif event_type in {"charge.refunded", "charge.dispute.created"}:
            if event_type == "charge.dispute.created":
                charge_id = obj.get("charge")
                if not charge_id:
                    return prepared
                charge_object = await asyncio.to_thread(
                    stripe.Charge.retrieve, charge_id, **self._request_options
                )
                charge: dict[str, Any] = json.loads(str(charge_object))
                obj["_resolved_charge"] = charge
            else:
                charge = obj
            invoice_id = self._object_id(charge.get("invoice"))
            if not invoice_id and charge.get("payment_intent"):
                payments = await asyncio.to_thread(
                    stripe.InvoicePayment.list,
                    payment={
                        "type": "payment_intent",
                        "payment_intent": charge["payment_intent"],
                    },
                    limit=1,
                    **self._request_options,
                )
                if payments.data:
                    payment: dict[str, Any] = json.loads(str(payments.data[0]))
                    invoice_id = self._object_id(payment.get("invoice"))
            if invoice_id:
                obj["_resolved_invoice_id"] = invoice_id
        return prepared

    async def _prepare_invoice_lines(self, invoice: dict[str, Any]) -> None:
        """Materialize the complete Invoice line collection before DB processing."""
        container = invoice.get("lines") or {}
        lines = list(container.get("data") or []) if isinstance(container, Mapping) else []
        if isinstance(container, Mapping) and container.get("has_more"):
            invoice_id = self._object_id(invoice.get("id"))
            if not invoice_id:
                raise RuntimeError("paginated Invoice lines require an Invoice id")
            lines = await self._list_invoice_lines(invoice_id)
        await self._resolve_lookups(lines)
        invoice["lines"] = {
            **(dict(container) if isinstance(container, Mapping) else {}),
            "data": lines,
            "has_more": False,
            "_all_lines_loaded": True,
        }

    async def _list_invoice_lines(self, invoice_id: str) -> list[dict[str, Any]]:
        lines: list[dict[str, Any]] = []
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
            page_lines = [json.loads(str(item)) for item in page.data]
            lines.extend(page_lines)
            if len(lines) > 1000:
                raise RuntimeError("Invoice has more than the supported 1000 lines")
            if not getattr(page, "has_more", False):
                return lines
            if not page_lines or not page_lines[-1].get("id"):
                raise RuntimeError("Stripe Invoice line pagination did not advance")
            starting_after = str(page_lines[-1]["id"])

    @staticmethod
    def _object_id(value: Any) -> str | None:
        if isinstance(value, str):
            return value
        if isinstance(value, Mapping) and value.get("id"):
            return str(value["id"])
        return None

    async def _resolve_lookups(self, lines: list[dict[str, Any]]) -> None:
        for line in lines:
            if self._inline_lookup(line):
                continue
            price_id = self._price_id(line)
            if not price_id:
                continue
            price = await asyncio.to_thread(
                stripe.Price.retrieve, price_id, **self._request_options
            )
            line["_resolved_lookup_key"] = price.lookup_key

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
        details = (line.get("pricing") or {}).get("price_details") or {}
        return str(details["price"]) if details.get("price") else None

    async def subscription_snapshot(self, subscription_id: str) -> SubscriptionSnapshot:
        subscription = await self.subscription_object(subscription_id)
        items = (subscription.get("items") or {}).get("data") or []
        lookup = self._inline_lookup(items[0]) if len(items) == 1 else None
        lookup = lookup or (items[0].get("_resolved_lookup_key") if len(items) == 1 else None)
        return SubscriptionSnapshot(subscription_id, subscription.get("status", ""), lookup)

    async def subscription_object(
        self, subscription_id: str, *, expand: list[str] | None = None
    ) -> dict[str, Any]:
        options: dict[str, Any] = dict(self._request_options)
        if expand:
            options["expand"] = expand
        subscription: dict[str, Any] = json.loads(
            str(
                await asyncio.to_thread(
                    stripe.Subscription.retrieve,
                    subscription_id,
                    **options,
                )
            )
        )
        items = (subscription.get("items") or {}).get("data") or []
        await self._resolve_lookups(items)
        return subscription

    async def latest_paid_invoice_event(self, subscription_id: str) -> dict[str, Any] | None:
        invoices = await asyncio.to_thread(
            stripe.Invoice.list,
            subscription=subscription_id,
            status="paid",
            limit=1,
            **self._request_options,
        )
        if not invoices.data:
            return None
        invoice: dict[str, Any] = json.loads(str(invoices.data[0]))
        event = {
            "id": f"reconcile:{invoice['id']}",
            "object": "event",
            "type": "invoice.paid",
            "created": int(
                (invoice.get("status_transitions") or {}).get("paid_at")
                or invoice.get("created")
                or 0
            ),
            "livemode": bool(invoice.get("livemode")),
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
            **self._request_options,
        )
        if len(prices.data) != 1:
            raise CheckoutCreationRejected(
                f"expected exactly one active Stripe price for {lookup_key!r}"
            )
        price_raw: dict[str, Any] = json.loads(str(prices.data[0]))
        recurring = price_raw.get("recurring") or {}
        if (
            str(price_raw.get("currency")) != expected_currency
            or int(price_raw.get("unit_amount") or 0) != expected_unit_amount
            or recurring.get("interval") != expected_interval
        ):
            raise CheckoutCreationRejected(f"Stripe price {lookup_key!r} drifted from the catalog")
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
            "metadata": {"claim_token": claim_token, "account_id": account_id},
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
        return str(session.id), str(session.url)

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
        config_raw: dict[str, Any] = json.loads(str(config))
        if not portal_configuration_is_safe(
            config_raw, expected_livemode=self.secret_key.startswith("sk_live_")
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
        return str(session.id), str(session.url)

    async def prepare_plan_change(
        self,
        subscription_id: str,
        target_lookup_key: str,
        *,
        expected_currency: str,
        expected_unit_amount: int,
        target_interval: BillingInterval,
    ) -> PlanChangeContext:
        prices = await asyncio.to_thread(
            stripe.Price.list,
            lookup_keys=[target_lookup_key],
            active=True,
            limit=2,
            **self._request_options,
        )
        if len(prices.data) != 1:
            raise RuntimeError(
                f"expected exactly one active Stripe price for {target_lookup_key!r}"
            )
        target_price: dict[str, Any] = json.loads(str(prices.data[0]))
        recurring = target_price.get("recurring") or {}
        if (
            str(target_price.get("currency")) != expected_currency
            or int(target_price.get("unit_amount") or 0) != expected_unit_amount
            or recurring.get("interval") != target_interval
        ):
            raise RuntimeError(f"Stripe price {target_lookup_key!r} drifted from the catalog")
        subscription = await self.subscription_object(
            subscription_id, expand=["latest_invoice.confirmation_secret"]
        )
        items = list((subscription.get("items") or {}).get("data") or [])
        if len(items) != 1:
            raise RuntimeError("subscription must contain exactly one item")
        item = items[0]
        current_lookup = self._inline_lookup(item) or item.get("_resolved_lookup_key")
        current_price_id = self._price_id(item)
        if not current_lookup or not current_price_id or not item.get("id"):
            raise RuntimeError("subscription item price cannot be resolved")
        start = item.get("current_period_start", subscription.get("current_period_start"))
        end = item.get("current_period_end", subscription.get("current_period_end"))
        if start is None or end is None:
            raise RuntimeError("subscription item period is missing")
        schedule_id = self._object_id(subscription.get("schedule"))
        pending = subscription.get("pending_update") or {}
        latest = subscription.get("latest_invoice")
        latest_invoice = latest if isinstance(latest, Mapping) else {}
        confirmation = latest_invoice.get("confirmation_secret") or {}
        client_secret = (
            confirmation.get("client_secret") if isinstance(confirmation, Mapping) else None
        )
        pending_expires = pending.get("expires_at") if isinstance(pending, Mapping) else None
        return PlanChangeContext(
            subscription_id,
            str(item["id"]),
            current_price_id,
            str(current_lookup),
            str(prices.data[0].id),
            target_interval,
            datetime.fromtimestamp(int(start), tz=UTC),
            datetime.fromtimestamp(int(end), tz=UTC),
            schedule_id,
            str(subscription.get("status") or ""),
            bool(subscription.get("cancel_at_period_end")),
            bool(pending),
            datetime.fromtimestamp(int(pending_expires), tz=UTC) if pending_expires else None,
            (
                str(latest_invoice["hosted_invoice_url"])
                if latest_invoice.get("hosted_invoice_url")
                else None
            ),
            str(client_secret) if client_secret else None,
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
        raw: dict[str, Any] = json.loads(str(preview))
        container = raw.get("lines") or {}
        lines = list(container.get("data") or []) if isinstance(container, Mapping) else []
        has_more = bool(container.get("has_more")) if isinstance(container, Mapping) else True
        invoice_currency = str(raw.get("currency") or "").lower()
        total = int(raw.get("total") or 0)
        amount_due = int(raw.get("amount_due") or 0)
        subtotal = int(raw.get("subtotal", total) or 0)
        target_non_proration = [
            line
            for line in lines
            if not self._line_is_proration(line) and self._price_id(line) == context.target_price_id
        ]
        starting_balance = int(raw.get("starting_balance") or 0)
        ending_balance = int(raw.get("ending_balance") or 0)
        proration_credit = sum(
            -int(line.get("amount") or 0)
            for line in lines
            if self._line_is_proration(line) and int(line.get("amount") or 0) < 0
        )
        source_prorations = [
            line
            for line in lines
            if self._line_is_proration(line)
            and self._price_id(line) == context.current_price_id
            and int(line.get("amount") or 0) < 0
        ]
        target_prorations = [
            line
            for line in lines
            if self._line_is_proration(line)
            and self._price_id(line) == context.target_price_id
            and int(line.get("amount") or 0) > 0
        ]
        tax_items = list(raw.get("total_tax_amounts") or []) + list(raw.get("total_taxes") or [])
        for line in lines:
            tax_items.extend(line.get("tax_amounts") or [])
            tax_items.extend(line.get("taxes") or [])
        tax_amount = sum(
            int(item.get("amount") or 0) for item in tax_items if isinstance(item, Mapping)
        )
        discount_items = list(raw.get("total_discount_amounts") or [])
        unsupported_line_adjustment = False
        for line in lines:
            discount_items.extend(line.get("discount_amounts") or [])
            for item in line.get("pretax_credit_amounts") or []:
                if isinstance(item, Mapping) and int(item.get("amount") or 0) != 0:
                    unsupported_line_adjustment = True
        discount_amount = sum(
            int(item.get("amount") or 0) for item in discount_items if isinstance(item, Mapping)
        )
        if raw.get("discounts") and discount_amount == 0:
            discount_amount = 1
        balance_fields = (
            starting_balance,
            ending_balance,
            int(raw.get("pre_payment_credit_notes_amount") or 0),
            int(raw.get("post_payment_credit_notes_amount") or 0),
        )
        common_safe = bool(
            not has_more
            and all(value == 0 for value in balance_fields)
            and tax_amount == 0
            and discount_amount == 0
            and not unsupported_line_adjustment
        )
        period_start: datetime | None = None
        period_end: datetime | None = None
        if policy == "prorated_delta":
            if len(source_prorations) == 1 and len(target_prorations) == 1:
                source_period = source_prorations[0].get("period") or {}
                target_period = target_prorations[0].get("period") or {}
                if source_period == target_period:
                    try:
                        period_start = datetime.fromtimestamp(int(target_period["start"]), tz=UTC)
                        period_end = datetime.fromtimestamp(int(target_period["end"]), tz=UTC)
                    except (KeyError, TypeError, ValueError, OSError):
                        period_start = None
                        period_end = None
            source_amount = (
                int(source_prorations[0].get("amount") or 0) if len(source_prorations) == 1 else 0
            )
            target_amount = (
                int(target_prorations[0].get("amount") or 0) if len(target_prorations) == 1 else 0
            )
            safe_shape = bool(
                common_safe
                and len(lines) == 2
                and len(source_prorations) == 1
                and len(target_prorations) == 1
                and all(line.get("id") for line in lines)
                and all(int(line.get("quantity") or 0) == 1 for line in lines)
                and source_amount < 0
                and target_amount > -source_amount > 0
                and source_amount + target_amount == total
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
            target_period = target_line.get("period") or {}
            try:
                full_period_start = datetime.fromtimestamp(int(target_period["start"]), tz=UTC)
                full_period_end = datetime.fromtimestamp(int(target_period["end"]), tz=UTC)
                valid_full_period = full_period_end > full_period_start
            except (KeyError, TypeError, ValueError, OSError):
                valid_full_period = False
            safe_shape = bool(
                common_safe
                and len(lines) == 1
                and len(target_non_proration) == 1
                and target_line.get("id")
                and int(target_line.get("quantity") or 0) == 1
                and int(target_line.get("amount") or 0) > 0
                and int(target_line.get("amount") or 0) == total == amount_due == subtotal
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
            (-int(source_prorations[0].get("amount") or 0) if len(source_prorations) == 1 else 0),
            (int(target_prorations[0].get("amount") or 0) if len(target_prorations) == 1 else 0),
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

        subscription: dict[str, Any] = json.loads(str(await asyncio.to_thread(_modify)))
        pending = subscription.get("pending_update") or {}
        latest_invoice = subscription.get("latest_invoice")
        invoice = latest_invoice if isinstance(latest_invoice, Mapping) else {}
        confirmation = invoice.get("confirmation_secret") or {}
        client_secret = (
            confirmation.get("client_secret") if isinstance(confirmation, Mapping) else None
        )
        expires = pending.get("expires_at") if isinstance(pending, Mapping) else None
        return RemotePlanChange(
            context.subscription_id,
            bool(pending),
            datetime.fromtimestamp(int(expires), tz=UTC) if expires else None,
            str(invoice["hosted_invoice_url"]) if invoice.get("hosted_invoice_url") else None,
            str(client_secret) if client_secret else None,
            self._object_id(invoice),
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
        if context.schedule_id and str(schedule.id) != context.schedule_id:
            raise RuntimeError("subscription is controlled by an unrelated Stripe Schedule")
        schedule_raw: dict[str, Any] = json.loads(str(schedule))
        phases = list(schedule_raw.get("phases") or [])
        if len(phases) == 2:
            if not self._configured_schedule_matches(schedule_raw, context, idempotency_key):
                raise RuntimeError("existing Stripe Schedule differs from this plan change")
            return RemotePlanChange(str(schedule.id))
        if len(phases) != 1:
            raise RuntimeError("new subscription schedule must contain one current phase")
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
                schedule.id,
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
        verified = await asyncio.to_thread(
            stripe.SubscriptionSchedule.retrieve,
            configured.id,
            **self._request_options,
        )
        verified_raw: dict[str, Any] = json.loads(str(verified))
        if not self._configured_schedule_matches(verified_raw, context, idempotency_key):
            raise RuntimeError("configured Stripe Schedule failed policy verification")
        return RemotePlanChange(str(configured.id))

    def _configured_schedule_matches(
        self,
        schedule: Mapping[str, Any],
        context: PlanChangeContext,
        plan_change_key: str,
    ) -> bool:
        phases = list(schedule.get("phases") or [])
        if len(phases) != 2:
            return False
        metadata = schedule.get("metadata") or {}
        subscription_id = self._object_id(schedule.get("subscription"))
        current_items = list(phases[0].get("items") or [])
        target_items = list(phases[1].get("items") or [])
        boundary = int(context.current_period_end.timestamp())
        return bool(
            subscription_id == context.subscription_id
            and schedule.get("end_behavior") == "release"
            and metadata.get("product_line") == self.product_line
            and metadata.get("plan_change_key") == plan_change_key
            and phases[0].get("end_date") == boundary
            and phases[1].get("start_date") == boundary
            and phases[0].get("proration_behavior") == "none"
            and phases[1].get("proration_behavior") == "none"
            and len(current_items) == 1
            and len(target_items) == 1
            and self._price_id(current_items[0]) == context.current_price_id
            and self._price_id(target_items[0]) == context.target_price_id
            and int(current_items[0].get("quantity") or 0) == 1
            and int(target_items[0].get("quantity") or 0) == 1
        )

    @staticmethod
    def _line_is_proration(line: Mapping[str, Any]) -> bool:
        return bool(
            line.get("proration")
            or ((line.get("parent") or {}).get("subscription_item_details") or {}).get("proration")
        )

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
        items: list[dict[str, Any]] = []
        for item in payload.get("items") or []:
            price_id = StripeGateway._price_id(item)
            if not price_id:
                raise RuntimeError("schedule phase item price cannot be resolved")
            items.append({"price": price_id, "quantity": int(item.get("quantity") or 1)})
        payload["items"] = items
        return payload
