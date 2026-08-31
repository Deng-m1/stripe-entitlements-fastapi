from __future__ import annotations

from dataclasses import replace
from itertools import pairwise
from pathlib import Path
from typing import Any, cast

import pytest

from stripe_entitlements.bounds import (
    CATALOG_PRICE_MAJOR_UNIT_MAX,
    JSON_SAFE_INTEGER_MAX,
    POSTGRES_BIGINT_MAX,
)
from stripe_entitlements.catalog import CreditPack, Plan, PlanCatalog
from stripe_entitlements.credit_amount import CreditAmount

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
        ("credits", "positive exact credit amount"),
        ("price", "JSON-safe"),
        ("limit", "JSON-safe limits"),
        ("rank", "JSON-safe"),
    ],
)
def test_catalog_values_must_fit_persisted_integer_boundaries(
    field: str, message: str, catalog: PlanCatalog
) -> None:
    plans = dict(catalog.plans)
    starter = plans["starter"]
    if field == "credits":
        plans["starter"] = replace(
            starter,
            monthly_credits=CreditAmount.from_atoms(POSTGRES_BIGINT_MAX + 1),
        )
    elif field == "price":
        plans["starter"] = replace(starter, month_usd=CATALOG_PRICE_MAJOR_UNIT_MAX + 1)
    elif field == "limit":
        limits = dict(starter.limits)
        limits["max_file_mb"] = JSON_SAFE_INTEGER_MAX + 1
        plans["starter"] = replace(starter, limits=limits)
    else:
        plans["starter"] = replace(starter, rank=JSON_SAFE_INTEGER_MAX + 1)
    with pytest.raises(ValueError, match=message):
        PlanCatalog(plans)


def test_credit_pack_value_must_fit_persisted_atom_boundary(catalog: PlanCatalog) -> None:
    packs = dict(catalog.credit_packs)
    pack = packs["boost-100"]
    packs[pack.key] = replace(
        pack,
        credits=CreditAmount.from_atoms(POSTGRES_BIGINT_MAX + 1),
    )

    with pytest.raises(ValueError, match="PostgreSQL bigint atom range"):
        PlanCatalog(dict(catalog.plans), credit_packs=packs)


@pytest.mark.parametrize(
    ("content", "owner", "field"),
    [
        (
            _BASE_CATALOG.replace(
                'features = ["pdf_to_ppt"]',
                'features = ["pdf_to_ppt"]\nunsupported = true',
            ),
            "plans.starter",
            "unsupported",
        ),
        (
            _BASE_CATALOG.replace(
                'features = ["pdf_to_ppt"]',
                'feature = ["pdf_to_ppt"]',
            ),
            "plans.starter",
            "feature",
        ),
        (
            _BASE_CATALOG
            + """
[credit_packs.boost]
name = "Boost"
description = "One-time credits"
currency = "usd"
rank = 10
credits = 100
price_usd = 9
expires_days = 365
expires_day = 365
""",
            "credit_packs.boost",
            "expires_day",
        ),
        (
            "catalog_version = 1\n" + _BASE_CATALOG,
            "plan catalog",
            "catalog_version",
        ),
    ],
)
def test_catalog_rejects_unknown_fields_instead_of_ignoring_typos(
    content: str,
    owner: str,
    field: str,
    tmp_path: Path,
) -> None:
    with pytest.raises(ValueError, match=rf"{owner} contains unknown fields: {field}"):
        _load(tmp_path, content)


def test_catalog_reports_missing_required_field(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="missing required field 'monthly_credits'"):
        _load(tmp_path, _BASE_CATALOG.replace("monthly_credits = 300\n", ""))


def test_catalog_accepts_integer_or_quoted_decimal_credits(tmp_path: Path) -> None:
    integer = _load(tmp_path, _BASE_CATALOG)
    fractional = _load(
        tmp_path,
        _BASE_CATALOG.replace("monthly_credits = 300", 'monthly_credits = "300.125"'),
    )
    assert integer.require("starter").monthly_credits.atoms == 300_000_000
    assert fractional.require("starter").monthly_credits.atoms == 300_125_000


def test_catalog_accepts_annual_price_above_twelve_monthly_payments(
    tmp_path: Path,
) -> None:
    catalog = _load(
        tmp_path,
        _BASE_CATALOG.replace("year_usd = 137", "year_usd = 229"),
    )

    assert catalog.require("starter").year_usd == 229


@pytest.mark.parametrize("shape", ["explicit_empty", "omitted"])
def test_catalog_accepts_plans_without_features_or_limits(shape: str, tmp_path: Path) -> None:
    if shape == "explicit_empty":
        content = _BASE_CATALOG.replace('features = ["pdf_to_ppt"]', "features = []").replace(
            "max_file_mb = 30\n", ""
        )
    else:
        content = _BASE_CATALOG.replace('features = ["pdf_to_ppt"]\n', "").replace(
            "\n[plans.starter.limits]\nmax_file_mb = 30\n", "\n"
        )

    plan = _load(tmp_path, content).require("starter")

    assert plan.features == frozenset()
    assert plan.limits == {}


def test_catalog_rejects_toml_float_credits(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="must not be a float"):
        _load(
            tmp_path,
            _BASE_CATALOG.replace("monthly_credits = 300", "monthly_credits = 300.125"),
        )


@pytest.mark.parametrize("prefix", ["", " bad ", "bad_prefix", "UPPER", "x" * 33])
def test_catalog_lookup_prefix_is_a_bounded_lowercase_slug(prefix: str, tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="lookup_prefix"):
        _load(tmp_path, _BASE_CATALOG, prefix=prefix)


def test_catalog_rejects_reserved_free_paid_plan(catalog: PlanCatalog) -> None:
    starter = catalog.require("starter")

    with pytest.raises(ValueError, match="reserved"):
        PlanCatalog({"free": replace(starter, key="free")})


def test_catalog_rejects_recurring_and_credit_pack_lookup_collision(
    catalog: PlanCatalog,
) -> None:
    plan = replace(catalog.require("starter"), key="pack")
    pack = replace(catalog.require_credit_pack("boost-100"), key="month")

    with pytest.raises(ValueError, match=r"lookup key.*collides"):
        PlanCatalog({"pack": plan}, credit_packs={"month": pack})


@pytest.mark.parametrize("namespace", ["features", "limits"])
def test_catalog_reserves_synthesized_monthly_credits_entitlement(
    namespace: str,
    catalog: PlanCatalog,
) -> None:
    starter = catalog.require("starter")
    if namespace == "features":
        plan = replace(starter, features=starter.features | {"monthly_credits"})
    else:
        plan = replace(starter, limits={**starter.limits, "monthly_credits": 1})

    with pytest.raises(ValueError, match="monthly_credits is reserved"):
        PlanCatalog({plan.key: plan})


def test_catalog_requires_feature_and_limit_namespaces_to_be_globally_disjoint(
    catalog: PlanCatalog,
) -> None:
    starter = replace(
        catalog.require("starter"),
        features=catalog.require("starter").features | {"shared_key"},
    )
    pro = replace(
        catalog.require("pro"),
        limits={**catalog.require("pro").limits, "shared_key": 1},
    )

    with pytest.raises(ValueError, match="globally disjoint: shared_key"):
        PlanCatalog({starter.key: starter, pro.key: pro})


@pytest.mark.parametrize(
    ("mutation", "message"),
    [
        ({"features": "api_access"}, "features must be a set"),
        ({"features": frozenset({cast(Any, 7)})}, "valid string keys"),
        ({"limits": cast(Any, [("jobs", 1)])}, "limits must be a mapping"),
        (
            {"monthly_credits": cast(Any, object())},
            "positive exact credit amount",
        ),
    ],
)
def test_direct_catalog_rejects_invalid_runtime_plan_shapes(
    mutation: dict[str, Any],
    message: str,
    catalog: PlanCatalog,
) -> None:
    plan = replace(catalog.require("starter"), **mutation)

    with pytest.raises(ValueError, match=message):
        PlanCatalog({plan.key: plan})


def test_direct_catalog_rejects_fake_credit_pack_amount(catalog: PlanCatalog) -> None:
    pack = replace(
        catalog.require_credit_pack("boost-100"),
        credits=cast(Any, object()),
    )

    with pytest.raises(ValueError, match="positive, exact"):
        PlanCatalog(
            {"starter": catalog.require("starter")},
            credit_packs={pack.key: pack},
        )


def test_python_catalog_defensively_copies_mutable_caller_input(
    catalog: PlanCatalog,
) -> None:
    source_features = {"private_feature"}
    source_limits = {"job_limit": 3}
    source_plan = replace(
        catalog.require("starter"),
        features=cast(Any, source_features),
        limits=source_limits,
    )
    source_pack = replace(catalog.require_credit_pack("boost-100"), key="boost")
    source_plans: dict[str, Plan] = {source_plan.key: source_plan}
    source_packs: dict[str, CreditPack] = {source_pack.key: source_pack}

    copied = PlanCatalog(source_plans, credit_packs=source_packs)
    source_features.add("later_feature")
    source_limits["job_limit"] = 99
    source_plans.clear()
    source_packs.clear()

    assert copied.require("starter").features == frozenset({"private_feature"})
    assert copied.require("starter").limits == {"job_limit": 3}
    assert copied.require_credit_pack("boost").key == "boost"


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


@pytest.mark.parametrize("tradeoff", ["credits", "features", "limits", "limit_keys"])
def test_catalog_accepts_product_defined_tradeoffs_between_ranked_plans(
    tradeoff: str, catalog: PlanCatalog
) -> None:
    plans = dict(catalog.plans)
    pro = plans["pro"]
    starter = plans["starter"]
    if tradeoff == "credits":
        plans["pro"] = replace(pro, monthly_credits=starter.monthly_credits)
    elif tradeoff == "features":
        plans["pro"] = replace(pro, features=frozenset({"api_access"}))
    elif tradeoff == "limits":
        limits = dict(pro.limits)
        limits["max_file_mb"] = starter.limits["max_file_mb"] - 1
        plans["pro"] = replace(pro, limits=limits)
    else:
        plans["pro"] = replace(pro, limits={"team_members": 5})

    accepted = PlanCatalog(plans)

    assert accepted.require("pro") == plans["pro"]


def test_direct_catalog_rejects_invalid_credit_pack_rank(catalog: PlanCatalog) -> None:
    packs = dict(catalog.credit_packs)
    pack = packs["boost-100"]
    packs[pack.key] = replace(pack, rank=0)

    with pytest.raises(ValueError, match="credit-pack ranks"):
        PlanCatalog(dict(catalog.plans), credit_packs=packs)


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
