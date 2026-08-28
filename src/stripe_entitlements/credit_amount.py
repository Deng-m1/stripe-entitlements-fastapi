from __future__ import annotations

import re
from dataclasses import dataclass
from decimal import Decimal
from typing import Any

from .bounds import POSTGRES_BIGINT_MAX

CREDIT_SCALE = 1_000_000
CREDIT_DECIMAL_PLACES = 6
MAX_CREDIT_ATOMS = POSTGRES_BIGINT_MAX
MAX_WHOLE_CREDITS = MAX_CREDIT_ATOMS // CREDIT_SCALE

_PLAIN_DECIMAL = re.compile(r"^(0|[1-9][0-9]*)(?:\.([0-9]{1,6}))?$")


def _plain_decimal_text(value: Any, *, field: str) -> str:
    if type(value) is int:
        if value < 0:
            raise ValueError(f"{field} must be non-negative")
        return str(value)
    if isinstance(value, Decimal):
        if not value.is_finite():
            raise ValueError(f"{field} must be finite")
        text = str(value)
        if "e" in text.lower():
            raise ValueError(f"{field} must not use exponent notation")
        return text
    if type(value) is str:
        return value
    if isinstance(value, (bool, float)):
        raise ValueError(f"{field} must not be a float or boolean")
    raise ValueError(f"{field} must be an integer, Decimal, or plain decimal string")


def credit_atoms(value: Any, *, field: str = "credit amount", allow_zero: bool = True) -> int:
    """Normalize a logical credit amount to exact fixed-point atoms.

    Integers retain the public API's historical meaning of whole credits. Decimal
    strings are deliberately parsed without binary floating-point or implicit
    rounding. Persisted values and internal arithmetic use the returned atoms.
    """

    text = _plain_decimal_text(value, field=field)
    match = _PLAIN_DECIMAL.fullmatch(text)
    if match is None:
        raise ValueError(
            f"{field} must be a non-negative plain decimal with at most "
            f"{CREDIT_DECIMAL_PLACES} fractional digits"
        )
    whole_text, fractional_text = match.group(1), match.group(2) or ""
    whole = int(whole_text)
    if whole > MAX_WHOLE_CREDITS:
        raise ValueError(f"{field} exceeds the PostgreSQL bigint atom range")
    atoms = whole * CREDIT_SCALE + int(fractional_text.ljust(CREDIT_DECIMAL_PLACES, "0") or 0)
    if atoms > MAX_CREDIT_ATOMS:
        raise ValueError(f"{field} exceeds the PostgreSQL bigint atom range")
    if not allow_zero and atoms == 0:
        raise ValueError(f"{field} must be greater than zero")
    return atoms


def credit_decimal(atoms: int, *, field: str = "credit atoms") -> str:
    """Serialize non-negative atoms as one canonical, exponent-free decimal string."""

    if type(atoms) is not int or atoms < 0 or atoms > MAX_CREDIT_ATOMS:
        raise ValueError(f"{field} must be a non-negative PostgreSQL bigint integer")
    whole, fractional = divmod(atoms, CREDIT_SCALE)
    if not fractional:
        return str(whole)
    return f"{whole}.{fractional:0{CREDIT_DECIMAL_PLACES}d}".rstrip("0")


def checked_add_atoms(left: int, right: int, *, field: str = "credit balance") -> int:
    """Add two non-negative atom quantities with an explicit bigint bound check."""

    if (
        type(left) is not int
        or type(right) is not int
        or left < 0
        or right < 0
        or left > MAX_CREDIT_ATOMS
        or right > MAX_CREDIT_ATOMS
    ):
        raise ValueError(f"{field} operands must be non-negative PostgreSQL bigint integers")
    if left > MAX_CREDIT_ATOMS - right:
        raise OverflowError(f"{field} exceeds the PostgreSQL bigint atom range")
    return left + right


@dataclass(frozen=True, slots=True, order=True)
class CreditAmount:
    """An exact, non-negative product-credit quantity stored as integer atoms."""

    atoms: int

    def __post_init__(self) -> None:
        if type(self.atoms) is not int or self.atoms < 0 or self.atoms > MAX_CREDIT_ATOMS:
            raise ValueError("credit atoms must be a non-negative PostgreSQL bigint integer")

    @classmethod
    def parse(
        cls,
        value: Any,
        *,
        field: str = "credit amount",
        allow_zero: bool = True,
    ) -> CreditAmount:
        return cls(credit_atoms(value, field=field, allow_zero=allow_zero))

    @classmethod
    def from_atoms(cls, atoms: int) -> CreditAmount:
        return cls(atoms)

    @property
    def decimal(self) -> Decimal:
        return Decimal(credit_decimal(self.atoms))

    def __str__(self) -> str:
        return credit_decimal(self.atoms)
