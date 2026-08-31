#!/usr/bin/env python3
"""Generate the public Next.js catalog snapshot from the enforced TOML catalog."""

from __future__ import annotations

import argparse
import json
import tomllib
from pathlib import Path
from typing import Any

from stripe_entitlements.catalog import PlanCatalog
from stripe_entitlements.credit_amount import CreditAmount

ROOT = Path(__file__).resolve().parents[1]


def _credit_text(value: object, *, field: str) -> str:
    return str(CreditAmount.parse(value, field=field, allow_zero=False))


def build_public_catalog(catalog_path: Path) -> dict[str, list[dict[str, Any]]]:
    """Validate and serialize one catalog without duplicating business values."""

    PlanCatalog.from_toml(catalog_path)
    with catalog_path.open("rb") as source:
        raw = tomllib.load(source)

    raw_plans = raw["plans"]
    raw_packs = raw.get("credit_packs", {})
    plans = [
        {
            "key": key,
            "name": value["name"],
            "description": value["description"],
            "currency": str(value["currency"]).upper(),
            "rank": value["rank"],
            "monthly_credits": _credit_text(
                value["monthly_credits"], field=f"plans.{key}.monthly_credits"
            ),
            "month_usd": value["month_usd"],
            "year_usd": value["year_usd"],
            "features": value.get("features", []),
            "limits": value.get("limits", {}),
        }
        for key, value in sorted(raw_plans.items(), key=lambda item: int(item[1]["rank"]))
    ]
    credit_packs = [
        {
            "key": key,
            "name": value["name"],
            "description": value["description"],
            "currency": str(value["currency"]).upper(),
            "rank": value["rank"],
            "credits": _credit_text(value["credits"], field=f"credit_packs.{key}.credits"),
            "price_usd": value["price_usd"],
            "expires_days": value["expires_days"],
        }
        for key, value in sorted(raw_packs.items(), key=lambda item: int(item[1]["rank"]))
    ]
    return {"plans": plans, "credit_packs": credit_packs}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", type=Path, default=ROOT / "plans.toml")
    parser.add_argument("--output", type=Path, default=ROOT / "web/reference-catalog.json")
    parser.add_argument(
        "--check",
        action="store_true",
        help="fail instead of writing when the checked-in snapshot is stale",
    )
    args = parser.parse_args()
    catalog_path = args.catalog.resolve()
    output_path = args.output.resolve()
    catalog = build_public_catalog(catalog_path)
    rendered = json.dumps(catalog, ensure_ascii=False, indent=2) + "\n"

    if args.check:
        observed = output_path.read_text(encoding="utf-8") if output_path.is_file() else ""
        if observed != rendered:
            raise SystemExit(
                "public catalog snapshot is stale; run "
                "`uv run python scripts/sync_reference_catalog.py`"
            )
        print(f"public-catalog-sync=ok plans={len(catalog['plans'])}")
        return 0

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(rendered, encoding="utf-8")
    print(f"wrote {output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
