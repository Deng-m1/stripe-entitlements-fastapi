from __future__ import annotations

import itertools
import time
from typing import Any

_counter = itertools.count(1)


def event(
    event_type: str,
    obj: dict[str, Any],
    *,
    event_id: str | None = None,
    created: int | None = None,
) -> dict[str, Any]:
    return {
        "id": event_id or f"evt_{next(_counter)}",
        "type": event_type,
        "created": created if created is not None else int(time.time()),
        "livemode": False,
        "data": {"object": obj},
    }


def paid_invoice(
    account_id: str,
    *,
    invoice_id: str = "in_test",
    customer: str = "cus_test",
    subscription: str = "sub_test",
    plan: str = "starter",
    interval: str = "month",
    amount: int = 1900,
    period_start: int = 1_800_000_000,
    period_end: int | None = None,
    event_id: str | None = None,
    created: int = 1_800_000_010,
    proration_amount: int | None = None,
    billing_reason: str = "subscription_cycle",
) -> dict[str, Any]:
    period_end = period_end or period_start + (31_536_000 if interval == "year" else 2_592_000)
    lines: list[dict[str, Any]] = [
        {
            "id": f"il_{invoice_id}",
            "amount": amount,
            "price": {"id": f"price_{plan}_{interval}", "lookup_key": f"ent_{plan}_{interval}"},
            "period": {"start": period_start, "end": period_end},
            "proration": False,
        }
    ]
    if proration_amount is not None:
        lines.append(
            {
                "id": f"il_proration_{invoice_id}",
                "amount": proration_amount,
                "price": {
                    "id": f"price_{plan}_{interval}",
                    "lookup_key": f"ent_{plan}_{interval}",
                },
                "period": {"start": period_start, "end": period_end},
                "proration": True,
            }
        )
    obj = {
        "id": invoice_id,
        "customer": customer,
        "subscription": subscription,
        "billing_reason": billing_reason,
        "amount_paid": amount,
        "total": amount,
        "parent": {
            "subscription_details": {
                "subscription": subscription,
                "metadata": {
                    "account_id": account_id,
                    "product_line": "example-entitlements",
                },
            }
        },
        "lines": {"data": lines},
    }
    return event("invoice.paid", obj, event_id=event_id, created=created)


def payment_failed(
    account_id: str,
    *,
    event_id: str | None = None,
    created: int = 1_800_000_010,
) -> dict[str, Any]:
    obj = {
        "id": "in_failed",
        "customer": "cus_test",
        "subscription": "sub_test",
        "metadata": {"account_id": account_id},
        "lines": {"data": []},
    }
    return event("invoice.payment_failed", obj, event_id=event_id, created=created)


def subscription_event(
    account_id: str,
    event_type: str = "customer.subscription.updated",
    *,
    status: str = "active",
    plan: str = "starter",
    interval: str = "month",
    subscription: str = "sub_test",
    event_id: str | None = None,
    created: int = 1_800_000_010,
) -> dict[str, Any]:
    obj = {
        "id": subscription,
        "customer": "cus_test",
        "status": status,
        "metadata": {"account_id": account_id},
        "current_period_end": 1_802_592_000,
        "items": {
            "data": [
                {
                    "id": "si_test",
                    "price": {
                        "id": f"price_{plan}_{interval}",
                        "lookup_key": f"ent_{plan}_{interval}",
                    },
                }
            ]
        },
    }
    return event(event_type, obj, event_id=event_id, created=created)


def refunded_charge(
    *,
    amount: int = 1900,
    amount_refunded: int = 950,
    invoice_id: str = "in_test",
    event_id: str | None = None,
    refunded: bool | None = None,
    created: int = 1_800_000_020,
) -> dict[str, Any]:
    refunded = amount_refunded >= amount if refunded is None else refunded
    obj = {
        "id": f"ch_{invoice_id}",
        "customer": "cus_test",
        "invoice": invoice_id,
        "amount": amount,
        "amount_refunded": amount_refunded,
        "refunded": refunded,
    }
    return event("charge.refunded", obj, event_id=event_id, created=created)


def dispute(
    *,
    invoice_id: str = "in_test",
    event_id: str | None = None,
    created: int = 1_800_000_020,
) -> dict[str, Any]:
    charge = {
        "id": f"ch_{invoice_id}",
        "customer": "cus_test",
        "invoice": invoice_id,
        "amount": 1900,
        "amount_refunded": 0,
        "refunded": False,
    }
    return event(
        "charge.dispute.created",
        {"id": f"dp_{invoice_id}", "charge": charge["id"], "_resolved_charge": charge},
        event_id=event_id,
        created=created,
    )


def checkout_event(
    event_type: str,
    account_id: str,
    session_id: str,
    *,
    subscription: str = "sub_checkout",
    event_id: str | None = None,
) -> dict[str, Any]:
    return event(
        event_type,
        {
            "id": session_id,
            "customer": "cus_checkout",
            "subscription": subscription,
            "client_reference_id": account_id,
            "metadata": {"account_id": account_id},
        },
        event_id=event_id,
    )
