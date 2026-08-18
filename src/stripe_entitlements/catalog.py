from __future__ import annotations

import re
import tomllib
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .bounds import CATALOG_PRICE_MAJOR_UNIT_MAX, POSTGRES_BIGINT_MAX

_KEY = re.compile(r"^[a-z][a-z0-9-]{0,31}$")
_ENTITLEMENT_KEY = re.compile(r"^[a-z][a-z0-9_]{0,63}$")


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


def _required_string(value: Any, *, field: str, max_bytes: int) -> str:
    if (
        type(value) is not str
        or not value
        or value != value.strip()
        or len(value.encode("utf-8")) > max_bytes
        or any(not character.isprintable() for character in value)
    ):
        raise ValueError(f"{field} must be a non-empty visible string up to {max_bytes} bytes")
    return value


def _required_integer(value: Any, *, field: str, minimum: int = 1) -> int:
    if type(value) is not int or value < minimum or value > POSTGRES_BIGINT_MAX:
        raise ValueError(f"{field} must be an integer between {minimum} and {POSTGRES_BIGINT_MAX}")
    return value


def _parse_features(value: Any, *, plan_key: str) -> frozenset[str]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        raise ValueError(f"plans.{plan_key}.features must be an array")
    features = [
        _required_string(item, field=f"plans.{plan_key}.features[]", max_bytes=64) for item in value
    ]
    if not features or len(features) != len(set(features)):
        raise ValueError(f"plans.{plan_key}.features must be non-empty and contain no duplicates")
    if any(_ENTITLEMENT_KEY.fullmatch(feature) is None for feature in features):
        raise ValueError(f"plans.{plan_key}.features contains an invalid key")
    return frozenset(features)


def _parse_limits(value: Any, *, plan_key: str) -> dict[str, int]:
    if not isinstance(value, Mapping) or not value:
        raise ValueError(f"plans.{plan_key}.limits must be a non-empty table")
    limits: dict[str, int] = {}
    for raw_key, raw_value in value.items():
        key = _required_string(raw_key, field=f"plans.{plan_key}.limits key", max_bytes=64)
        if _ENTITLEMENT_KEY.fullmatch(key) is None:
            raise ValueError(f"plans.{plan_key}.limits contains an invalid key")
        limits[key] = _required_integer(
            raw_value,
            field=f"plans.{plan_key}.limits.{key}",
            minimum=0,
        )
    return limits


class PlanCatalog:
    def __init__(self, plans: dict[str, Plan], lookup_prefix: str = "ent") -> None:
        if not plans:
            raise ValueError("at least one plan is required")
        if _KEY.fullmatch(lookup_prefix) is None:
            raise ValueError("lookup_prefix must match [a-z][a-z0-9-]{0,31}")
        ranks = [plan.rank for plan in plans.values()]
        if any(type(rank) is not int or rank <= 0 for rank in ranks) or len(ranks) != len(
            set(ranks)
        ):
            raise ValueError("plan ranks must be unique positive integers")
        for key, plan in plans.items():
            if key != plan.key or _KEY.fullmatch(key) is None:
                raise ValueError("plan keys must match their mapping key and use lowercase slugs")
            _required_string(plan.name, field=f"plans.{key}.name", max_bytes=120)
            _required_string(plan.description, field=f"plans.{key}.description", max_bytes=500)
            if plan.currency != "usd":
                raise ValueError("the reference catalog supports USD only")
            _required_integer(plan.monthly_credits, field=f"plans.{key}.monthly_credits")
            _required_integer(plan.month_usd, field=f"plans.{key}.month_usd")
            _required_integer(plan.year_usd, field=f"plans.{key}.year_usd")
            if (
                plan.month_usd > CATALOG_PRICE_MAJOR_UNIT_MAX
                or plan.year_usd > CATALOG_PRICE_MAJOR_UNIT_MAX
            ):
                raise ValueError("catalog prices in minor units must fit a PostgreSQL bigint")
            if plan.year_usd > plan.month_usd * 12:
                raise ValueError(f"plans.{key}.year_usd cannot exceed twelve monthly payments")
            if not plan.features or any(
                type(feature) is not str or _ENTITLEMENT_KEY.fullmatch(feature) is None
                for feature in plan.features
            ):
                raise ValueError("every plan requires explicit valid non-empty features")
            if not plan.limits or any(
                type(name) is not str
                or _ENTITLEMENT_KEY.fullmatch(name) is None
                or type(value) is not int
                or value < 0
                or value > POSTGRES_BIGINT_MAX
                for name, value in plan.limits.items()
            ):
                raise ValueError("every plan requires explicit valid non-negative limits")
        ordered = sorted(plans.values(), key=lambda plan: plan.rank)
        expected_limit_keys = set(ordered[0].limits)
        previous = ordered[0]
        for plan in ordered[1:]:
            if set(plan.limits) != expected_limit_keys:
                raise ValueError("all plans must define the same explicit limit keys")
            if plan.monthly_credits <= previous.monthly_credits:
                raise ValueError("monthly credits must increase strictly with plan rank")
            if not plan.features.issuperset(previous.features):
                raise ValueError("higher-ranked plans cannot remove lower-tier features")
            if any(plan.limits[key] < previous.limits[key] for key in expected_limit_keys):
                raise ValueError("higher-ranked plans cannot reduce lower-tier limits")
            previous = plan
        self.plans = plans
        self.lookup_prefix = lookup_prefix

    @classmethod
    def from_toml(cls, path: str | Path, lookup_prefix: str = "ent") -> PlanCatalog:
        try:
            with Path(path).open("rb") as handle:
                raw = tomllib.load(handle)
        except (OSError, tomllib.TOMLDecodeError) as exc:
            raise ValueError(f"cannot load plan catalog: {type(exc).__name__}") from exc
        raw_plans = raw.get("plans")
        if not isinstance(raw_plans, Mapping) or not raw_plans:
            raise ValueError("plan catalog requires a non-empty [plans] table")
        plans: dict[str, Plan] = {}
        for raw_key, raw_value in raw_plans.items():
            key = _required_string(raw_key, field="plan key", max_bytes=32)
            if not isinstance(raw_value, Mapping):
                raise ValueError(f"plans.{key} must be a table")
            try:
                plans[key] = Plan(
                    key=key,
                    name=_required_string(
                        raw_value["name"], field=f"plans.{key}.name", max_bytes=120
                    ),
                    description=_required_string(
                        raw_value["description"],
                        field=f"plans.{key}.description",
                        max_bytes=500,
                    ),
                    currency=_required_string(
                        raw_value["currency"], field=f"plans.{key}.currency", max_bytes=3
                    ),
                    rank=_required_integer(raw_value["rank"], field=f"plans.{key}.rank"),
                    monthly_credits=_required_integer(
                        raw_value["monthly_credits"],
                        field=f"plans.{key}.monthly_credits",
                    ),
                    month_usd=_required_integer(
                        raw_value["month_usd"], field=f"plans.{key}.month_usd"
                    ),
                    year_usd=_required_integer(
                        raw_value["year_usd"], field=f"plans.{key}.year_usd"
                    ),
                    features=_parse_features(raw_value["features"], plan_key=key),
                    limits=_parse_limits(raw_value["limits"], plan_key=key),
                )
            except KeyError as exc:
                raise ValueError(f"plans.{key} is missing required field {exc.args[0]!r}") from exc
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
