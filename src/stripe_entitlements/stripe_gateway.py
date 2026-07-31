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
from .transitions import BillingInterval
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
            await self._resolve_lookups((obj.get("lines") or {}).get("data") or [])
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

    async def subscription_object(self, subscription_id: str) -> dict[str, Any]:
        subscription: dict[str, Any] = json.loads(
            str(
                await asyncio.to_thread(
                    stripe.Subscription.retrieve,
                    subscription_id,
                    **self._request_options,
                )
            )
        )
        items = (subscription.get("items") or {}).get("data") or []
        await self._resolve_lookups(items)
        return subscription

    async def latest_paid_invoice_event(
        self, subscription_id: str
    ) -> dict[str, Any] | None:
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
            raise CheckoutCreationRejected(
                f"Stripe price {lookup_key!r} drifted from the catalog"
            )
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
            raise RuntimeError(
                f"Stripe price {target_lookup_key!r} drifted from the catalog"
            )
        subscription = await self.subscription_object(subscription_id)
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
        )

    async def preview_immediate_plan_change(
        self,
        context: PlanChangeContext,
    ) -> PlanChangeEstimate:
        preview = await asyncio.to_thread(
            stripe.Invoice.create_preview,
            subscription=context.subscription_id,
            subscription_details={
                "items": [
                    {
                        "id": context.subscription_item_id,
                        "price": context.target_price_id,
                    }
                ],
                "billing_cycle_anchor": "now",
                "proration_behavior": "none",
            },
            **self._request_options,
        )
        raw: dict[str, Any] = json.loads(str(preview))
        lines = list((raw.get("lines") or {}).get("data") or [])
        target_non_proration = [
            line
            for line in lines
            if not self._line_is_proration(line)
            and self._price_id(line) == context.target_price_id
        ]
        other_positive = [
            line
            for line in lines
            if int(line.get("amount") or 0) > 0 and line not in target_non_proration
        ]
        starting_balance = int(raw.get("starting_balance") or 0)
        ending_balance = int(raw.get("ending_balance") or 0)
        proration_credit = sum(
            -int(line.get("amount") or 0)
            for line in lines
            if self._line_is_proration(line) and int(line.get("amount") or 0) < 0
        )
        return PlanChangeEstimate(
            int(raw.get("amount_due") or 0),
            proration_credit,
            max(-starting_balance, -ending_balance, 0),
            str(raw.get("currency") or "usd"),
            len(target_non_proration) == 1 and not other_positive,
        )

    async def apply_immediate_plan_change(
        self,
        context: PlanChangeContext,
        *,
        idempotency_key: str,
    ) -> RemotePlanChange:
        def _modify() -> Any:
            return stripe.Subscription.modify(
                context.subscription_id,
                items=[
                    {
                        "id": context.subscription_item_id,
                        "price": context.target_price_id,
                    }
                ],
                billing_cycle_anchor="now",
                proration_behavior="none",
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
        return RemotePlanChange(str(configured.id))

    @staticmethod
    def _line_is_proration(line: Mapping[str, Any]) -> bool:
        return bool(
            line.get("proration")
            or ((line.get("parent") or {}).get("subscription_item_details") or {}).get(
                "proration"
            )
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
