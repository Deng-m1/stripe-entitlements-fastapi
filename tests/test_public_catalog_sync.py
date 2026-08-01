from __future__ import annotations

import json
import tomllib
from pathlib import Path


def test_public_reference_catalog_matches_enforced_plan_catalog() -> None:
    root = Path(__file__).parents[1]
    with (root / "plans.toml").open("rb") as source:
        enforced = tomllib.load(source)["plans"]
    public = json.loads(
        (root / "web" / "reference-catalog.json").read_text(encoding="utf-8")
    )["plans"]

    assert [plan["key"] for plan in public] == [
        key
        for key, _ in sorted(
            enforced.items(), key=lambda item: int(item[1]["rank"])
        )
    ]
    for published in public:
        plan = enforced[published["key"]]
        assert published == {
            "key": published["key"],
            "name": plan["name"],
            "description": plan["description"],
            "currency": str(plan["currency"]).upper(),
            "rank": plan["rank"],
            "monthly_credits": plan["monthly_credits"],
            "month_usd": plan["month_usd"],
            "year_usd": plan["year_usd"],
            "features": plan["features"],
            "limits": plan["limits"],
        }
