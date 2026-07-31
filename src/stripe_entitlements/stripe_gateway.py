from __future__ import annotations

import asyncio
import copy
import json
from collections.abc import Mapping
from datetime import datetime
from typing import Any

import stripe

from .types import SubscriptionSnapshot


class StripeGateway:
    def __init__(
        self,
        secret_key: str,
        webhook_secret: str,
        product_line: str = "example-entitlements",
    ) -> None:
        if not secret_key.startswith(("sk_test_", "sk_live_")):
            raise ValueError("Stripe secret key must be an sk_test_ or sk_live_ key")
        self.secret_key = secret_key
        self.webhook_secret = webhook_secret
        self.product_line = product_line

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
                    stripe.Charge.retrieve, charge_id, api_key=self.secret_key
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
                    api_key=self.secret_key,
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
                stripe.Price.retrieve, price_id, api_key=self.secret_key
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
                    api_key=self.secret_key,
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
            api_key=self.secret_key,
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
        claim_token: str,
        expires_at: datetime,
    ) -> tuple[str, str]:
        prices = await asyncio.to_thread(
            stripe.Price.list,
            lookup_keys=[lookup_key],
            active=True,
            limit=1,
            api_key=self.secret_key,
        )
        if not prices.data:
            raise RuntimeError(f"Stripe price {lookup_key!r} is missing")
        params: dict[str, Any] = {
            "mode": "subscription",
            "client_reference_id": account_id,
            "line_items": [{"price": prices.data[0].id, "quantity": 1}],
            "subscription_data": {
                "metadata": {
                    "account_id": account_id,
                    "product_line": self.product_line,
                }
            },
            "success_url": "http://localhost:8000/billing/success",
            "cancel_url": "http://localhost:8000/billing/canceled",
            "expires_at": int(expires_at.timestamp()),
            "metadata": {"claim_token": claim_token, "account_id": account_id},
        }
        if customer_id:
            params["customer"] = customer_id

        def _create() -> Any:
            return stripe.checkout.Session.create(
                **params,
                idempotency_key=f"checkout:{account_id}:{claim_token}",
                api_key=self.secret_key,
            )

        session = await asyncio.to_thread(
            _create,
        )
        return str(session.id), str(session.url)
