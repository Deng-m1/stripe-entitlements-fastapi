from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import pytest

from stripe_entitlements.invoice_policy import has_unsupported_invoice_adjustments


@pytest.mark.parametrize(
    ("invoice", "lines"),
    [
        pytest.param({"discount": {}}, [], id="discount-empty-object"),
        pytest.param(
            {"total_discount_amounts": [{"amount": 0}]},
            [],
            id="zero-valued-discount-object",
        ),
        pytest.param(
            {},
            [{"discount_amounts": [{"amount": 0}]}],
            id="zero-valued-line-discount-object",
        ),
        pytest.param(
            {"total_tax_amounts": [{"amount": 0}]},
            [],
            id="zero-valued-tax-object",
        ),
        pytest.param(
            {},
            [{"tax_amounts": [{"amount": 0}]}],
            id="zero-valued-line-tax-object",
        ),
        pytest.param(
            {"automatic_tax": {"enabled": True}},
            [],
            id="automatic-tax",
        ),
        pytest.param({"starting_balance": -1}, [], id="starting-balance"),
        pytest.param({"ending_balance": 1}, [], id="ending-balance"),
        pytest.param(
            {"pre_payment_credit_notes_amount": 1},
            [],
            id="pre-payment-credit-note",
        ),
        pytest.param(
            {"post_payment_credit_notes_amount": 1},
            [],
            id="post-payment-credit-note",
        ),
        pytest.param({"amount_overpaid": 1}, [], id="amount-overpaid"),
    ],
)
def test_rejects_discount_tax_and_balance_participation(
    invoice: Mapping[str, Any], lines: list[Mapping[str, Any]]
) -> None:
    assert has_unsupported_invoice_adjustments(invoice, lines) is True


def test_accepts_explicitly_empty_adjustment_fields_and_zero_balances() -> None:
    invoice = {
        "starting_balance": 0,
        "ending_balance": 0,
        "pre_payment_credit_notes_amount": 0,
        "post_payment_credit_notes_amount": 0,
        "amount_overpaid": 0,
        "automatic_tax": {"enabled": False},
        "discount": None,
        "discounts": [],
        "default_tax_rates": [],
        "total_tax_amounts": [],
        "total_taxes": [],
        "total_discount_amounts": [],
    }
    lines = [
        {
            "discounts": [],
            "tax_amounts": [],
            "taxes": [],
            "discount_amounts": [],
            "pretax_credit_amounts": [],
            "tax_rates": [],
        }
    ]

    assert has_unsupported_invoice_adjustments(invoice, lines) is False
