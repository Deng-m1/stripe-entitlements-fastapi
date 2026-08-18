from __future__ import annotations

from collections.abc import Mapping
from typing import Any


def has_unsupported_invoice_adjustments(
    invoice: Mapping[str, Any], lines: list[Mapping[str, Any]]
) -> bool:
    """Reject any tax, discount, balance, or credit-note participation.

    Presence matters even when the current computed amount is zero: a zero-valued tax
    or discount object still means the Invoice shape is outside this reference model.
    """
    balance_fields = (
        "starting_balance",
        "ending_balance",
        "pre_payment_credit_notes_amount",
        "post_payment_credit_notes_amount",
        "amount_overpaid",
    )
    for field in balance_fields:
        value = invoice.get(field)
        if value is not None and (type(value) is not int or value != 0):
            return True
    automatic_tax = invoice.get("automatic_tax")
    if automatic_tax is not None:
        if not isinstance(automatic_tax, Mapping):
            return True
        enabled = automatic_tax.get("enabled")
        if not isinstance(enabled, bool) or enabled:
            return True
    if invoice.get("discount") is not None:
        return True
    for field in (
        "discounts",
        "default_tax_rates",
        "total_tax_amounts",
        "total_taxes",
        "total_discount_amounts",
    ):
        value = invoice.get(field)
        if value is not None and (not isinstance(value, list) or bool(value)):
            return True
    for line in lines:
        for field in (
            "discounts",
            "tax_amounts",
            "taxes",
            "discount_amounts",
            "pretax_credit_amounts",
            "tax_rates",
        ):
            value = line.get(field)
            if value is not None and (not isinstance(value, list) or bool(value)):
                return True
    return False


def has_unsupported_invoice_payment_shape(invoice: Mapping[str, Any]) -> bool:
    """Keep fulfillment on the single Stripe-collected payment model.

    Older Event snapshots can omit ``payments`` entirely. When the collection is
    present, this template accepts at most one paid card/PaymentIntent mapping and
    rejects pagination, out-of-band payment records, or additional payment mappings.
    """
    paid_out_of_band = invoice.get("paid_out_of_band")
    if paid_out_of_band not in {None, False}:
        return True
    amount_overpaid = invoice.get("amount_overpaid")
    if amount_overpaid is not None and (type(amount_overpaid) is not int or amount_overpaid != 0):
        return True
    payments = invoice.get("payments")
    if payments is None:
        return False
    if not isinstance(payments, Mapping) or payments.get("has_more"):
        return True
    raw_data = payments.get("data")
    if raw_data is None:
        return False
    if not isinstance(raw_data, list):
        return True
    data = list(raw_data)
    if len(data) > 1:
        return True
    if not data:
        return False
    payment = data[0]
    if not isinstance(payment, Mapping):
        return True
    if payment.get("status") not in {None, "paid"}:
        return True
    payment_details = payment.get("payment") or {}
    if not isinstance(payment_details, Mapping):
        return True
    return payment_details.get("type") not in {None, "charge", "payment_intent"}
