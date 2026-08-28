from __future__ import annotations

from decimal import Decimal, localcontext

import pytest

from stripe_entitlements.credit_amount import (
    CREDIT_SCALE,
    MAX_CREDIT_ATOMS,
    CreditAmount,
    checked_add_atoms,
    credit_atoms,
    credit_decimal,
)


@pytest.mark.parametrize(
    ("value", "atoms", "canonical"),
    [
        (0, 0, "0"),
        (300, 300_000_000, "300"),
        ("300.500000", 300_500_000, "300.5"),
        ("0.000001", 1, "0.000001"),
        (Decimal("1.25"), 1_250_000, "1.25"),
    ],
)
def test_credit_amount_round_trips_exactly(value: object, atoms: int, canonical: str) -> None:
    amount = CreditAmount.parse(value)
    assert amount.atoms == atoms
    assert str(amount) == canonical
    assert CreditAmount.from_atoms(atoms).decimal == Decimal(canonical)


@pytest.mark.parametrize(
    "value",
    [
        True,
        False,
        0.1,
        "1e-6",
        Decimal("1E+3"),
        "0.0000001",
        "01",
        "+1",
        "-0",
        " 1",
        "1 ",
        "NaN",
        Decimal("NaN"),
        Decimal("Infinity"),
    ],
)
def test_credit_amount_rejects_inexact_or_noncanonical_inputs(value: object) -> None:
    with pytest.raises(ValueError):
        CreditAmount.parse(value)


def test_credit_amount_rejects_zero_when_positive_is_required() -> None:
    with pytest.raises(ValueError, match="greater than zero"):
        CreditAmount.parse("0.000000", allow_zero=False)


def test_credit_amount_enforces_postgresql_bigint_atom_boundary() -> None:
    assert credit_atoms("9223372036854.775807") == MAX_CREDIT_ATOMS
    assert credit_decimal(MAX_CREDIT_ATOMS) == "9223372036854.775807"
    with pytest.raises(ValueError, match="bigint atom range"):
        credit_atoms("9223372036854.775808")
    with pytest.raises(ValueError, match="bigint atom range"):
        credit_atoms("9223372036855")


def test_credit_scale_is_an_explicit_protocol_constant() -> None:
    assert CREDIT_SCALE == 1_000_000


def test_credit_atom_addition_fails_before_bigint_overflow() -> None:
    assert checked_add_atoms(MAX_CREDIT_ATOMS - 1, 1) == MAX_CREDIT_ATOMS
    with pytest.raises(OverflowError, match="bigint atom range"):
        checked_add_atoms(MAX_CREDIT_ATOMS, 1)


def test_decimal_conversion_is_independent_of_callers_decimal_context() -> None:
    with localcontext() as context:
        context.prec = 6
        value = CreditAmount.from_atoms(MAX_CREDIT_ATOMS).decimal
    assert value == Decimal("9223372036854.775807")
