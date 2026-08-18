from __future__ import annotations

import copy

import pytest

from stripe_entitlements.price_policy import catalog_price_matches


def _price() -> dict[str, object]:
    return {
        "id": "price_starter_month",
        "lookup_key": "ent_starter_month",
        "active": True,
        "type": "recurring",
        "currency": "usd",
        "unit_amount": 1900,
        "billing_scheme": "per_unit",
        "recurring": {
            "interval": "month",
            "interval_count": 1,
            "usage_type": "licensed",
        },
        "tax_behavior": "unspecified",
        "tiers_mode": None,
        "transform_quantity": None,
        "custom_unit_amount": None,
        "currency_options": None,
        "product": {
            "id": "prod_starter",
            "active": True,
            "metadata": {
                "product_line": "example-entitlements",
                "plan": "starter",
            },
        },
    }


def _matches(price: dict[str, object], *, require_active: bool = True) -> bool:
    return catalog_price_matches(
        price,
        expected_currency="usd",
        expected_unit_amount=1900,
        expected_interval="month",
        expected_product_line="example-entitlements",
        expected_plan_key="starter",
        expected_lookup_key="ent_starter_month",
        expected_price_id="price_starter_month",
        require_active=require_active,
    )


def test_catalog_price_policy_accepts_exact_supported_shape() -> None:
    assert _matches(_price())


def test_catalog_price_policy_accepts_expanded_default_currency_option() -> None:
    price = _price()
    price["currency_options"] = {
        "usd": {
            "custom_unit_amount": None,
            "tax_behavior": "unspecified",
            "unit_amount": 1900,
            "unit_amount_decimal": "1900",
        }
    }
    assert _matches(price)


@pytest.mark.parametrize(
    "currency_options",
    [
        {"eur": {"unit_amount": 1900}},
        {"usd": {"unit_amount": 1900}, "eur": {"unit_amount": 1900}},
        {"usd": {"unit_amount": "1900"}},
        {"usd": {"unit_amount": 1800}},
        {"usd": {"unit_amount": 1900, "custom_unit_amount": {"enabled": True}}},
        {"usd": {"unit_amount": 1900, "tax_behavior": "exclusive"}},
    ],
)
def test_catalog_price_policy_rejects_unsupported_currency_options(
    currency_options: dict[str, object],
) -> None:
    price = _price()
    price["currency_options"] = currency_options
    assert not _matches(price)


def test_archived_historical_price_is_allowed_only_when_requested() -> None:
    price = _price()
    price["active"] = False
    product = price["product"]
    assert isinstance(product, dict)
    product["active"] = False
    assert not _matches(price)
    assert _matches(price, require_active=False)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("unit_amount", "1900"),
        ("unit_amount", True),
        ("unit_amount", 1900.0),
        ("currency", 123),
        ("currency", "USD"),
        ("active", "true"),
        ("lookup_key", "ent_pro_month"),
        ("id", "price_other"),
    ],
)
def test_catalog_price_policy_rejects_top_level_type_and_identity_drift(
    field: str, value: object
) -> None:
    price = _price()
    price[field] = value
    assert not _matches(price)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("interval", "year"),
        ("interval_count", "1"),
        ("interval_count", True),
        ("interval_count", 2),
        ("usage_type", "metered"),
    ],
)
def test_catalog_price_policy_rejects_recurring_contract_drift(field: str, value: object) -> None:
    price = _price()
    recurring = price["recurring"]
    assert isinstance(recurring, dict)
    recurring[field] = value
    assert not _matches(price)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("active", "true"),
        ("metadata", []),
    ],
)
def test_catalog_price_policy_rejects_product_shape_drift(field: str, value: object) -> None:
    price = _price()
    product = price["product"]
    assert isinstance(product, dict)
    product[field] = value
    assert not _matches(price)


def test_catalog_price_policy_accepts_price_metadata_when_product_metadata_is_absent() -> None:
    price = _price()
    product = price["product"]
    assert isinstance(product, dict)
    product["metadata"] = {}
    price["metadata"] = {
        "product_line": "example-entitlements",
        "plan": "starter",
    }
    assert _matches(price)


@pytest.mark.parametrize("metadata_field", ["product_line", "plan"])
def test_catalog_price_policy_rejects_product_metadata_identity_drift(
    metadata_field: str,
) -> None:
    price = _price()
    product = price["product"]
    assert isinstance(product, dict)
    metadata = product["metadata"]
    assert isinstance(metadata, dict)
    metadata[metadata_field] = "other"
    assert not _matches(price)


@pytest.mark.parametrize("metadata_field", ["product_line", "plan"])
def test_catalog_price_policy_rejects_price_metadata_identity_drift(
    metadata_field: str,
) -> None:
    price = _price()
    price["metadata"] = {
        "product_line": "example-entitlements",
        "plan": "starter",
    }
    metadata = price["metadata"]
    assert isinstance(metadata, dict)
    metadata[metadata_field] = "other"
    assert not _matches(price)


def test_catalog_price_policy_allows_missing_or_split_nonconflicting_metadata() -> None:
    price = _price()
    product = price["product"]
    assert isinstance(product, dict)
    product["metadata"] = {}
    assert _matches(price)

    product["metadata"] = {"product_line": "example-entitlements"}
    price["metadata"] = {"plan": "starter"}
    assert _matches(price)


def test_catalog_price_policy_never_mutates_remote_shape() -> None:
    price = _price()
    before = copy.deepcopy(price)
    assert _matches(price)
    assert price == before
