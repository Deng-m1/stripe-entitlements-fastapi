from __future__ import annotations

import re
import tomllib
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .bounds import CATALOG_PRICE_MAJOR_UNIT_MAX, JSON_SAFE_INTEGER_MAX, POSTGRES_BIGINT_MAX
from .credit_amount import CreditAmount

_KEY = re.compile(r"^[a-z][a-z0-9-]{0,31}$")
_ENTITLEMENT_KEY = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
_ROOT_FIELDS = frozenset({"plans", "credit_packs"})
_PLAN_FIELDS = frozenset(
    {
        "name",
        "description",
        "currency",
        "rank",
        "monthly_credits",
        "month_usd",
        "year_usd",
        "features",
        "limits",
    }
)
_CREDIT_PACK_FIELDS = frozenset(
    {"name", "description", "currency", "rank", "credits", "price_usd", "expires_days"}
)


@dataclass(frozen=True, slots=True)
class Plan:
    key: str
    name: str
    description: str
    currency: str
    rank: int
    monthly_credits: CreditAmount
    month_usd: int
    year_usd: int
    features: frozenset[str]
    limits: dict[str, int]


@dataclass(frozen=True, slots=True)
class CreditPack:
    """One server-owned, one-time Stripe Price mapped to exact product credits."""

    key: str
    name: str
    description: str
    currency: str
    rank: int
    credits: CreditAmount
    price_usd: int
    expires_days: int


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


def _required_integer(
    value: Any,
    *,
    field: str,
    minimum: int = 1,
    maximum: int = POSTGRES_BIGINT_MAX,
) -> int:
    if type(value) is not int or value < minimum or value > maximum:
        raise ValueError(f"{field} must be an integer between {minimum} and {maximum}")
    return value


def _parse_features(value: Any, *, plan_key: str) -> frozenset[str]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        raise ValueError(f"plans.{plan_key}.features must be an array")
    features = [
        _required_string(item, field=f"plans.{plan_key}.features[]", max_bytes=64) for item in value
    ]
    if len(features) != len(set(features)):
        raise ValueError(f"plans.{plan_key}.features must contain no duplicates")
    if any(_ENTITLEMENT_KEY.fullmatch(feature) is None for feature in features):
        raise ValueError(f"plans.{plan_key}.features contains an invalid key")
    return frozenset(features)


def _parse_limits(value: Any, *, plan_key: str) -> dict[str, int]:
    if not isinstance(value, Mapping):
        raise ValueError(f"plans.{plan_key}.limits must be a table")
    limits: dict[str, int] = {}
    for raw_key, raw_value in value.items():
        key = _required_string(raw_key, field=f"plans.{plan_key}.limits key", max_bytes=64)
        if _ENTITLEMENT_KEY.fullmatch(key) is None:
            raise ValueError(f"plans.{plan_key}.limits contains an invalid key")
        limits[key] = _required_integer(
            raw_value,
            field=f"plans.{plan_key}.limits.{key}",
            minimum=0,
            maximum=JSON_SAFE_INTEGER_MAX,
        )
    return limits


def _reject_unknown_fields(
    value: Mapping[str, Any], *, owner: str, allowed: frozenset[str]
) -> None:
    unknown = sorted(set(value) - allowed)
    if unknown:
        raise ValueError(f"{owner} contains unknown fields: {', '.join(unknown)}")


class PlanCatalog:
    def __init__(
        self,
        plans: Mapping[str, Plan],
        lookup_prefix: str = "ent",
        *,
        credit_packs: Mapping[str, CreditPack] | None = None,
    ) -> None:
        if not isinstance(plans, Mapping) or not plans:
            raise ValueError("at least one plan is required")
        if type(lookup_prefix) is not str or _KEY.fullmatch(lookup_prefix) is None:
            raise ValueError("lookup_prefix must match [a-z][a-z0-9-]{0,31}")
        canonical_plans: dict[str, Plan] = {}
        feature_keys: set[str] = set()
        limit_keys: set[str] = set()
        for key, plan in plans.items():
            if type(key) is not str or not isinstance(plan, Plan):
                raise ValueError("plans must map lowercase slug keys to Plan values")
            if key == "free":
                raise ValueError("'free' is reserved for the non-paid account state")
            if key != plan.key or _KEY.fullmatch(key) is None:
                raise ValueError("plan keys must match their mapping key and use lowercase slugs")
            _required_string(plan.name, field=f"plans.{key}.name", max_bytes=120)
            _required_string(plan.description, field=f"plans.{key}.description", max_bytes=500)
            if plan.currency != "usd":
                raise ValueError("the reference catalog supports USD only")
            credit_atoms = getattr(plan.monthly_credits, "atoms", None)
            if (
                type(plan.monthly_credits) is not CreditAmount
                or type(credit_atoms) is not int
                or credit_atoms <= 0
                or credit_atoms > POSTGRES_BIGINT_MAX
            ):
                raise ValueError(
                    f"plans.{key}.monthly_credits must be a positive exact credit amount "
                    "within the PostgreSQL bigint atom range"
                )
            _required_integer(plan.month_usd, field=f"plans.{key}.month_usd")
            _required_integer(plan.year_usd, field=f"plans.{key}.year_usd")
            if (
                plan.month_usd > CATALOG_PRICE_MAJOR_UNIT_MAX
                or plan.year_usd > CATALOG_PRICE_MAJOR_UNIT_MAX
            ):
                raise ValueError("catalog prices in minor units must remain JSON-safe integers")
            if not isinstance(plan.features, (set, frozenset)):
                raise ValueError("plan features must be a set of valid string keys")
            features = frozenset(plan.features)
            if any(
                type(feature) is not str or _ENTITLEMENT_KEY.fullmatch(feature) is None
                for feature in features
            ):
                raise ValueError("plan features must contain only valid string keys")
            if not isinstance(plan.limits, Mapping):
                raise ValueError("plan limits must be a mapping of keys to integer values")
            limits = dict(plan.limits)
            if any(
                type(name) is not str
                or _ENTITLEMENT_KEY.fullmatch(name) is None
                or type(value) is not int
                or value < 0
                or value > JSON_SAFE_INTEGER_MAX
                for name, value in limits.items()
            ):
                raise ValueError(
                    "plan limits must contain only valid non-negative JSON-safe limits"
                )
            if "monthly_credits" in features or "monthly_credits" in limits:
                raise ValueError(
                    "monthly_credits is reserved and cannot be declared as a feature or limit"
                )
            feature_keys.update(features)
            limit_keys.update(limits)
            canonical_plans[key] = Plan(
                key=key,
                name=plan.name,
                description=plan.description,
                currency="usd",
                rank=plan.rank,
                monthly_credits=CreditAmount.from_atoms(credit_atoms),
                month_usd=plan.month_usd,
                year_usd=plan.year_usd,
                features=features,
                limits=limits,
            )
        ranks = [plan.rank for plan in canonical_plans.values()]
        if any(
            type(rank) is not int or rank <= 0 or rank > JSON_SAFE_INTEGER_MAX for rank in ranks
        ) or len(ranks) != len(set(ranks)):
            raise ValueError("plan ranks must be unique positive JSON-safe integers")
        overlap = sorted(feature_keys & limit_keys)
        if overlap:
            raise ValueError(
                "feature and limit entitlement keys must be globally disjoint: "
                + ", ".join(overlap)
            )
        if credit_packs is not None and not isinstance(credit_packs, Mapping):
            raise ValueError("credit_packs must map lowercase slug keys to CreditPack values")
        supplied_packs = credit_packs or {}
        canonical_packs: dict[str, CreditPack] = {}
        for key, pack in supplied_packs.items():
            if type(key) is not str or not isinstance(pack, CreditPack):
                raise ValueError("credit_packs must map lowercase slug keys to CreditPack values")
            if key != pack.key or _KEY.fullmatch(key) is None:
                raise ValueError(
                    "credit-pack keys must match their mapping key and use lowercase slugs"
                )
            _required_string(pack.name, field=f"credit_packs.{key}.name", max_bytes=120)
            _required_string(
                pack.description, field=f"credit_packs.{key}.description", max_bytes=500
            )
            if pack.currency != "usd":
                raise ValueError("the reference credit-pack catalog supports USD only")
            credit_atoms = getattr(pack.credits, "atoms", None)
            if (
                type(pack.credits) is not CreditAmount
                or type(credit_atoms) is not int
                or credit_atoms <= 0
                or credit_atoms > POSTGRES_BIGINT_MAX
            ):
                raise ValueError(
                    f"credit_packs.{key}.credits must be positive, exact, and within the "
                    "PostgreSQL bigint atom range"
                )
            _required_integer(
                pack.price_usd,
                field=f"credit_packs.{key}.price_usd",
                maximum=CATALOG_PRICE_MAJOR_UNIT_MAX,
            )
            _required_integer(
                pack.expires_days,
                field=f"credit_packs.{key}.expires_days",
                maximum=3650,
            )
            canonical_packs[key] = CreditPack(
                key=key,
                name=pack.name,
                description=pack.description,
                currency="usd",
                rank=pack.rank,
                credits=CreditAmount.from_atoms(credit_atoms),
                price_usd=pack.price_usd,
                expires_days=pack.expires_days,
            )
        pack_ranks = [pack.rank for pack in canonical_packs.values()]
        if any(
            type(rank) is not int or rank <= 0 or rank > JSON_SAFE_INTEGER_MAX
            for rank in pack_ranks
        ) or len(pack_ranks) != len(set(pack_ranks)):
            raise ValueError("credit-pack ranks must be unique positive JSON-safe integers")
        lookup_owners: dict[str, str] = {}
        for key in canonical_plans:
            for interval in ("month", "year"):
                lookup_key = f"{lookup_prefix}_{key}_{interval}"
                lookup_owners[lookup_key] = f"plan {key!r} ({interval})"
        for key in canonical_packs:
            lookup_key = f"{lookup_prefix}_pack_{key}"
            previous = lookup_owners.get(lookup_key)
            if previous is not None:
                raise ValueError(
                    f"generated Stripe lookup key {lookup_key!r} collides between "
                    f"{previous} and credit pack {key!r}"
                )
            lookup_owners[lookup_key] = f"credit pack {key!r}"
        self.plans = canonical_plans
        self.credit_packs = canonical_packs
        self.lookup_prefix = lookup_prefix

    @classmethod
    def from_toml(cls, path: str | Path, lookup_prefix: str = "ent") -> PlanCatalog:
        try:
            with Path(path).open("rb") as handle:
                raw = tomllib.load(handle)
        except (OSError, tomllib.TOMLDecodeError) as exc:
            raise ValueError(f"cannot load plan catalog: {type(exc).__name__}") from exc
        _reject_unknown_fields(raw, owner="plan catalog", allowed=_ROOT_FIELDS)
        raw_plans = raw.get("plans")
        if not isinstance(raw_plans, Mapping) or not raw_plans:
            raise ValueError("plan catalog requires a non-empty [plans] table")
        plans: dict[str, Plan] = {}
        for raw_key, raw_value in raw_plans.items():
            key = _required_string(raw_key, field="plan key", max_bytes=32)
            if not isinstance(raw_value, Mapping):
                raise ValueError(f"plans.{key} must be a table")
            _reject_unknown_fields(raw_value, owner=f"plans.{key}", allowed=_PLAN_FIELDS)
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
                    rank=_required_integer(
                        raw_value["rank"],
                        field=f"plans.{key}.rank",
                        maximum=JSON_SAFE_INTEGER_MAX,
                    ),
                    monthly_credits=CreditAmount.parse(
                        raw_value["monthly_credits"],
                        field=f"plans.{key}.monthly_credits",
                        allow_zero=False,
                    ),
                    month_usd=_required_integer(
                        raw_value["month_usd"], field=f"plans.{key}.month_usd"
                    ),
                    year_usd=_required_integer(
                        raw_value["year_usd"], field=f"plans.{key}.year_usd"
                    ),
                    features=_parse_features(raw_value.get("features", []), plan_key=key),
                    limits=_parse_limits(raw_value.get("limits", {}), plan_key=key),
                )
            except KeyError as exc:
                raise ValueError(f"plans.{key} is missing required field {exc.args[0]!r}") from exc
        raw_packs = raw.get("credit_packs", {})
        if not isinstance(raw_packs, Mapping):
            raise ValueError("credit_packs must be a table")
        packs: dict[str, CreditPack] = {}
        for raw_key, raw_value in raw_packs.items():
            key = _required_string(raw_key, field="credit-pack key", max_bytes=32)
            if not isinstance(raw_value, Mapping):
                raise ValueError(f"credit_packs.{key} must be a table")
            _reject_unknown_fields(
                raw_value,
                owner=f"credit_packs.{key}",
                allowed=_CREDIT_PACK_FIELDS,
            )
            try:
                packs[key] = CreditPack(
                    key=key,
                    name=_required_string(
                        raw_value["name"], field=f"credit_packs.{key}.name", max_bytes=120
                    ),
                    description=_required_string(
                        raw_value["description"],
                        field=f"credit_packs.{key}.description",
                        max_bytes=500,
                    ),
                    currency=_required_string(
                        raw_value["currency"],
                        field=f"credit_packs.{key}.currency",
                        max_bytes=3,
                    ),
                    rank=_required_integer(
                        raw_value["rank"],
                        field=f"credit_packs.{key}.rank",
                        maximum=JSON_SAFE_INTEGER_MAX,
                    ),
                    credits=CreditAmount.parse(
                        raw_value["credits"],
                        field=f"credit_packs.{key}.credits",
                        allow_zero=False,
                    ),
                    price_usd=_required_integer(
                        raw_value["price_usd"], field=f"credit_packs.{key}.price_usd"
                    ),
                    expires_days=_required_integer(
                        raw_value["expires_days"],
                        field=f"credit_packs.{key}.expires_days",
                        maximum=3650,
                    ),
                )
            except KeyError as exc:
                raise ValueError(
                    f"credit_packs.{key} is missing required field {exc.args[0]!r}"
                ) from exc
        return cls(plans, lookup_prefix, credit_packs=packs)

    def ordered(self) -> tuple[Plan, ...]:
        return tuple(sorted(self.plans.values(), key=lambda plan: plan.rank))

    def require(self, plan: str) -> Plan:
        try:
            return self.plans[plan]
        except KeyError as exc:
            raise ValueError(f"unknown plan {plan!r}") from exc

    def ordered_credit_packs(self) -> tuple[CreditPack, ...]:
        return tuple(sorted(self.credit_packs.values(), key=lambda pack: pack.rank))

    def require_credit_pack(self, key: str) -> CreditPack:
        try:
            return self.credit_packs[key]
        except KeyError as exc:
            raise ValueError(f"unknown credit pack {key!r}") from exc

    def credit_pack_lookup_key(self, key: str) -> str:
        if key not in self.credit_packs:
            raise ValueError(f"unknown credit pack {key!r}")
        return f"{self.lookup_prefix}_pack_{key}"

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
