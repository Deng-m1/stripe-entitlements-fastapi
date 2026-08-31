from __future__ import annotations

import json
import subprocess
import sys
import tomllib
from pathlib import Path

from scripts.sync_reference_catalog import build_public_catalog
from stripe_entitlements.credit_amount import CreditAmount


def test_public_reference_catalog_matches_enforced_plan_catalog() -> None:
    root = Path(__file__).parents[1]
    with (root / "plans.toml").open("rb") as source:
        enforced = tomllib.load(source)["plans"]
    public = json.loads((root / "web" / "reference-catalog.json").read_text(encoding="utf-8"))[
        "plans"
    ]

    assert [plan["key"] for plan in public] == [
        key for key, _ in sorted(enforced.items(), key=lambda item: int(item[1]["rank"]))
    ]
    for published in public:
        plan = enforced[published["key"]]
        assert published == {
            "key": published["key"],
            "name": plan["name"],
            "description": plan["description"],
            "currency": str(plan["currency"]).upper(),
            "rank": plan["rank"],
            "monthly_credits": str(
                CreditAmount.parse(
                    plan["monthly_credits"],
                    field=f"plans.{published['key']}.monthly_credits",
                    allow_zero=False,
                )
            ),
            "month_usd": plan["month_usd"],
            "year_usd": plan["year_usd"],
            "features": plan["features"],
            "limits": plan["limits"],
        }

    enforced_packs = tomllib.loads((root / "plans.toml").read_text(encoding="utf-8"))[
        "credit_packs"
    ]
    public_packs = json.loads(
        (root / "web" / "reference-catalog.json").read_text(encoding="utf-8")
    )["credit_packs"]
    assert [pack["key"] for pack in public_packs] == [
        key for key, _ in sorted(enforced_packs.items(), key=lambda item: int(item[1]["rank"]))
    ]
    for published in public_packs:
        pack = enforced_packs[published["key"]]
        assert published == {
            "key": published["key"],
            "name": pack["name"],
            "description": pack["description"],
            "currency": str(pack["currency"]).upper(),
            "rank": pack["rank"],
            "credits": str(
                CreditAmount.parse(
                    pack["credits"],
                    field=f"credit_packs.{published['key']}.credits",
                    allow_zero=False,
                )
            ),
            "price_usd": pack["price_usd"],
            "expires_days": pack["expires_days"],
        }


def test_public_reference_catalog_generator_is_clean() -> None:
    root = Path(__file__).parents[1]
    completed = subprocess.run(
        [sys.executable, "scripts/sync_reference_catalog.py", "--check"],
        cwd=root,
        check=False,
        capture_output=True,
        text=True,
    )
    assert completed.returncode == 0, completed.stderr


def test_public_catalog_generator_preserves_optional_empty_entitlements(
    tmp_path: Path,
) -> None:
    catalog_path = tmp_path / "plans.toml"
    catalog_path.write_text(
        """[plans.credits-only]
name = "Credits only"
description = "A plan with no feature flags or numeric limits."
currency = "usd"
rank = 10
monthly_credits = 10
month_usd = 5
year_usd = 60
""",
        encoding="utf-8",
    )

    plan = build_public_catalog(catalog_path)["plans"][0]

    assert plan["features"] == []
    assert plan["limits"] == {}
