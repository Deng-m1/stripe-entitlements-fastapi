from __future__ import annotations

from dataclasses import replace
from itertools import pairwise
from pathlib import Path

import pytest

from stripe_entitlements.bounds import CATALOG_PRICE_MAJOR_UNIT_MAX, POSTGRES_BIGINT_MAX
from stripe_entitlements.catalog import PlanCatalog

_BASE_CATALOG = """
[plans.starter]
name = "Starter"
description = "Starter plan"
currency = "usd"
rank = 10
monthly_credits = 300
month_usd = 19
year_usd = 137
features = ["pdf_to_ppt"]

[plans.starter.limits]
max_file_mb = 30
"""


def _load(tmp_path: Path, content: str, *, prefix: str = "ent") -> PlanCatalog:
    path = tmp_path / "plans.toml"
    path.write_text(content, encoding="utf-8")
    return PlanCatalog.from_toml(path, prefix)


@pytest.mark.parametrize(
    ("old", "new", "message"),
    [
        ("rank = 10", "rank = true", "integer"),
        ("month_usd = 19", 'month_usd = "19"', "integer"),
        ('currency = "usd"', 'currency = "eur"', "USD only"),
        ("year_usd = 137", "year_usd = 229", "twelve monthly"),
        (
            'features = ["pdf_to_ppt"]',
            'features = ["pdf_to_ppt", "pdf_to_ppt"]',
            "duplicates",
        ),
    ],
)
def test_catalog_rejects_coercion_and_unsupported_billing_shapes(
    old: str,
    new: str,
    message: str,
    tmp_path: Path,
) -> None:
    with pytest.raises(ValueError, match=message):
        _load(tmp_path, _BASE_CATALOG.replace(old, new))


@pytest.mark.parametrize(
    ("field", "message"),
    [
        ("credits", "integer between"),
        ("price", "minor units"),
        ("limit", "non-negative limits"),
    ],
)
def test_catalog_values_must_fit_persisted_integer_boundaries(
    field: str, message: str, catalog: PlanCatalog
) -> None:
    plans = dict(catalog.plans)
    starter = plans["starter"]
    if field == "credits":
        plans["starter"] = replace(starter, monthly_credits=POSTGRES_BIGINT_MAX + 1)
    elif field == "price":
        plans["starter"] = replace(starter, month_usd=CATALOG_PRICE_MAJOR_UNIT_MAX + 1)
    else:
        limits = dict(starter.limits)
        limits["max_file_mb"] = POSTGRES_BIGINT_MAX + 1
        plans["starter"] = replace(starter, limits=limits)
    with pytest.raises(ValueError, match=message):
        PlanCatalog(plans)


def test_catalog_reports_missing_required_field(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="missing required field 'monthly_credits'"):
        _load(tmp_path, _BASE_CATALOG.replace("monthly_credits = 300\n", ""))


@pytest.mark.parametrize("prefix", ["", " bad ", "bad_prefix", "UPPER", "x" * 33])
def test_catalog_lookup_prefix_is_a_bounded_lowercase_slug(prefix: str, tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="lookup_prefix"):
        _load(tmp_path, _BASE_CATALOG, prefix=prefix)


def test_catalog_rejects_invalid_or_duplicate_entitlement_keys(tmp_path: Path) -> None:
    invalid_feature = _BASE_CATALOG.replace("pdf_to_ppt", "PDF To PPT")
    with pytest.raises(ValueError, match="invalid key"):
        _load(tmp_path, invalid_feature)
    invalid_limit = _BASE_CATALOG.replace("max_file_mb", "Max_File")
    with pytest.raises(ValueError, match="invalid key"):
        _load(tmp_path, invalid_limit)


@pytest.mark.parametrize("malformation", ["missing_plans", "invalid_toml"])
def test_catalog_file_shape_fails_with_a_stable_value_error(
    malformation: str, tmp_path: Path
) -> None:
    content = "name = 'no plans'\n" if malformation == "missing_plans" else "[plans."
    with pytest.raises(ValueError):
        _load(tmp_path, content)


@pytest.mark.parametrize("drift", ["credits", "features", "limits", "limit_keys"])
def test_higher_ranked_plans_cannot_remove_entitlement_value(
    drift: str, catalog: PlanCatalog
) -> None:
    plans = dict(catalog.plans)
    pro = plans["pro"]
    starter = plans["starter"]
    if drift == "credits":
        plans["pro"] = replace(pro, monthly_credits=starter.monthly_credits)
        message = "credits"
    elif drift == "features":
        plans["pro"] = replace(pro, features=frozenset({"pdf_to_ppt"}))
        message = "features"
    elif drift == "limits":
        limits = dict(pro.limits)
        limits["max_file_mb"] = starter.limits["max_file_mb"] - 1
        plans["pro"] = replace(pro, limits=limits)
        message = "limits"
    else:
        limits = dict(pro.limits)
        limits.pop("api_keys")
        plans["pro"] = replace(pro, limits=limits)
        message = "limit keys"
    with pytest.raises(ValueError, match=message):
        PlanCatalog(plans)


def test_plan_rank_does_not_depend_on_price_order(catalog: PlanCatalog) -> None:
    plans = dict(catalog.plans)
    pro = plans["pro"]
    plans["pro"] = replace(pro, month_usd=1, year_usd=1)
    assert [plan.key for plan in PlanCatalog(plans).ordered()] == ["starter", "pro", "ultra"]


def test_current_catalog_has_monotonic_entitlements(catalog: PlanCatalog) -> None:
    ordered = catalog.ordered()
    assert [plan.key for plan in ordered] == ["starter", "pro", "ultra"]
    assert [plan.monthly_credits for plan in ordered] == sorted(
        plan.monthly_credits for plan in ordered
    )
    assert [plan.month_usd for plan in ordered] == sorted(plan.month_usd for plan in ordered)
    assert [plan.year_usd for plan in ordered] == sorted(plan.year_usd for plan in ordered)
    assert all(current.features.issubset(target.features) for current, target in pairwise(ordered))
