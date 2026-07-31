from __future__ import annotations

import tomllib
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True, slots=True)
class Plan:
    key: str
    monthly_credits: int
    month_usd: int
    year_usd: int


class PlanCatalog:
    def __init__(self, plans: dict[str, Plan], lookup_prefix: str = "ent") -> None:
        if not plans:
            raise ValueError("at least one plan is required")
        if not lookup_prefix or "_" in lookup_prefix:
            raise ValueError("lookup_prefix must be non-empty and contain no underscore")
        self.plans = plans
        self.lookup_prefix = lookup_prefix

    @classmethod
    def from_toml(cls, path: str | Path, lookup_prefix: str = "ent") -> PlanCatalog:
        with Path(path).open("rb") as handle:
            raw = tomllib.load(handle)
        plans = {
            key: Plan(
                key=key,
                monthly_credits=int(value["monthly_credits"]),
                month_usd=int(value["month_usd"]),
                year_usd=int(value["year_usd"]),
            )
            for key, value in raw["plans"].items()
        }
        return cls(plans, lookup_prefix)

    def lookup_key(self, plan: str, interval: str) -> str:
        if plan not in self.plans or interval not in {"month", "year"}:
            raise ValueError("unknown plan or interval")
        return f"{self.lookup_prefix}_{plan}_{interval}"

    def parse_lookup_key(self, lookup_key: str | None) -> tuple[Plan, str] | None:
        if not lookup_key:
            return None
        parts = lookup_key.split("_")
        if len(parts) != 3 or parts[0] != self.lookup_prefix:
            return None
        plan = self.plans.get(parts[1])
        if plan is None or parts[2] not in {"month", "year"}:
            return None
        return plan, parts[2]
