from __future__ import annotations

import tomllib
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True, slots=True)
class Plan:
    key: str
    name: str
    description: str
    currency: str
    rank: int
    monthly_credits: int
    month_usd: int
    year_usd: int
    features: frozenset[str]
    limits: dict[str, int]


class PlanCatalog:
    def __init__(self, plans: dict[str, Plan], lookup_prefix: str = "ent") -> None:
        if not plans:
            raise ValueError("at least one plan is required")
        if not lookup_prefix or "_" in lookup_prefix:
            raise ValueError("lookup_prefix must be non-empty and contain no underscore")
        ranks = [plan.rank for plan in plans.values()]
        if any(rank <= 0 for rank in ranks) or len(ranks) != len(set(ranks)):
            raise ValueError("plan ranks must be unique positive integers")
        for key, plan in plans.items():
            if key != plan.key or "_" in key:
                raise ValueError("plan keys must match their mapping key and contain no underscore")
            if plan.monthly_credits <= 0 or plan.month_usd <= 0 or plan.year_usd <= 0:
                raise ValueError("credits and prices must be positive")
            if len(plan.currency) != 3 or plan.currency.lower() != plan.currency:
                raise ValueError("currency must be a lowercase ISO 4217 code")
            if not plan.features or any(not feature for feature in plan.features):
                raise ValueError("every plan requires explicit non-empty features")
            if not plan.limits or any(value < 0 for value in plan.limits.values()):
                raise ValueError("every plan requires explicit non-negative limits")
        self.plans = plans
        self.lookup_prefix = lookup_prefix

    @classmethod
    def from_toml(cls, path: str | Path, lookup_prefix: str = "ent") -> PlanCatalog:
        with Path(path).open("rb") as handle:
            raw = tomllib.load(handle)
        plans = {
            key: Plan(
                key=key,
                name=str(value["name"]),
                description=str(value["description"]),
                currency=str(value["currency"]),
                rank=int(value["rank"]),
                monthly_credits=int(value["monthly_credits"]),
                month_usd=int(value["month_usd"]),
                year_usd=int(value["year_usd"]),
                features=frozenset(str(item) for item in value["features"]),
                limits={name: int(limit) for name, limit in value["limits"].items()},
            )
            for key, value in raw["plans"].items()
        }
        return cls(plans, lookup_prefix)

    def ordered(self) -> tuple[Plan, ...]:
        return tuple(sorted(self.plans.values(), key=lambda plan: plan.rank))

    def require(self, plan: str) -> Plan:
        try:
            return self.plans[plan]
        except KeyError as exc:
            raise ValueError(f"unknown plan {plan!r}") from exc

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
