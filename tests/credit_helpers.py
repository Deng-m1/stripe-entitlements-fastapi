from __future__ import annotations

from dataclasses import replace
from decimal import Decimal

from stripe_entitlements.catalog import PlanCatalog
from stripe_entitlements.credit_amount import CreditAmount


def atoms(value: int | str | Decimal) -> int:
    """Return persisted fixed-point atoms for a logical test credit amount."""

    return CreditAmount.parse(value).atoms


STARTER_CREDITS = atoms(300)
PRO_CREDITS = atoms(1_000)
ULTRA_CREDITS = atoms(4_000)


def catalog_with_credits(
    catalog: PlanCatalog,
    *,
    starter: int | str | Decimal,
    pro: int | str | Decimal,
    ultra: int | str | Decimal,
) -> PlanCatalog:
    values = {"starter": starter, "pro": pro, "ultra": ultra}
    plans = {
        key: replace(
            plan,
            monthly_credits=CreditAmount.parse(
                values[key], field=f"plans.{key}.monthly_credits", allow_zero=False
            ),
        )
        for key, plan in catalog.plans.items()
    }
    return PlanCatalog(plans, catalog.lookup_prefix)
