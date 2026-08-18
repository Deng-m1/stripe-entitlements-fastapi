from __future__ import annotations

from collections.abc import Mapping
from typing import Any


def _currency_options_match(
    value: Any, *, expected_currency: str, expected_unit_amount: int
) -> bool:
    if value is None or value == {}:
        return True
    if not isinstance(value, Mapping) or set(value) != {expected_currency}:
        return False
    option = value.get(expected_currency)
    if not isinstance(option, Mapping):
        return False
    unit_amount = option.get("unit_amount")
    return bool(
        type(unit_amount) is int
        and unit_amount == expected_unit_amount
        and option.get("custom_unit_amount") is None
        and option.get("tax_behavior") in {None, "unspecified"}
    )


def _catalog_identity_matches(
    price: Mapping[str, Any],
    product: Mapping[str, Any],
    *,
    expected_product_line: str,
    expected_plan_key: str,
) -> bool:
    metadata_values = (price.get("metadata"), product.get("metadata"))
    for metadata in metadata_values:
        if metadata is None:
            continue
        if not isinstance(metadata, Mapping):
            return False
        observed_product_line = metadata.get("product_line")
        observed_plan = metadata.get("plan")
        if observed_product_line is not None and observed_product_line != expected_product_line:
            return False
        if observed_plan is not None and observed_plan != expected_plan_key:
            return False
    return True


def catalog_price_matches(
    price: Mapping[str, Any],
    *,
    expected_currency: str,
    expected_unit_amount: int,
    expected_interval: str,
    expected_product_line: str,
    expected_plan_key: str,
    expected_lookup_key: str | None = None,
    expected_price_id: str | None = None,
    require_active: bool = True,
) -> bool:
    recurring = price.get("recurring")
    product = price.get("product")
    price_active = price.get("active", True)
    product_active = product.get("active", True) if isinstance(product, Mapping) else None
    active_matches = bool(not require_active or (price_active is True and product_active is True))
    currency = price.get("currency")
    unit_amount = price.get("unit_amount")
    interval_count = recurring.get("interval_count", 1) if isinstance(recurring, Mapping) else None
    return bool(
        isinstance(recurring, Mapping)
        and isinstance(product, Mapping)
        and active_matches
        and _catalog_identity_matches(
            price,
            product,
            expected_product_line=expected_product_line,
            expected_plan_key=expected_plan_key,
        )
        and (expected_lookup_key is None or price.get("lookup_key") == expected_lookup_key)
        and (expected_price_id is None or price.get("id") == expected_price_id)
        and isinstance(currency, str)
        and currency == currency.lower()
        and currency == expected_currency
        and type(unit_amount) is int
        and unit_amount == expected_unit_amount
        and recurring.get("interval") == expected_interval
        and type(interval_count) is int
        and interval_count == 1
        and recurring.get("usage_type", "licensed") == "licensed"
        and price.get("type", "recurring") == "recurring"
        and price.get("billing_scheme", "per_unit") == "per_unit"
        and price.get("tiers_mode") is None
        and price.get("transform_quantity") is None
        and price.get("custom_unit_amount") is None
        and _currency_options_match(
            price.get("currency_options"),
            expected_currency=expected_currency,
            expected_unit_amount=expected_unit_amount,
        )
        and price.get("tax_behavior") in {None, "unspecified"}
    )
