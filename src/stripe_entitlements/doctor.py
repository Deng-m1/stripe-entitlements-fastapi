from __future__ import annotations

import asyncio
import hashlib
import re
from collections.abc import Mapping
from dataclasses import dataclass
from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as distribution_version
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlsplit

import stripe

from . import __version__
from .catalog import PlanCatalog
from .config import (
    Settings,
    checkout_success_base_url_is_safe,
    get_settings,
    public_http_url_is_structurally_safe,
)
from .database import Database
from .portal_policy import portal_configuration_is_safe
from .price_policy import catalog_one_time_price_matches, catalog_price_matches
from .resources import default_migration_directory

DoctorStatus = Literal["pass", "warning", "fail", "skipped"]

_PLACEHOLDER_MARKERS = (
    "replace_me",
    "replace-with",
    "replace_with",
    "changeme",
    "change_me",
    "dummy",
    "your_key",
    "your_secret",
)
_VERSION = re.compile(r"^\d{4}-\d{2}-\d{2}\.[a-z][a-z0-9_]*$")


@dataclass(frozen=True, slots=True)
class DoctorCheck:
    name: str
    status: DoctorStatus
    summary: str

    def as_dict(self) -> dict[str, str]:
        return {"name": self.name, "status": self.status, "summary": self.summary}


@dataclass(frozen=True, slots=True)
class DoctorReport:
    version: str
    checks: tuple[DoctorCheck, ...]

    @property
    def ok(self) -> bool:
        return all(check.status != "fail" for check in self.checks)

    def as_dict(self) -> dict[str, object]:
        counts = {
            status: sum(check.status == status for check in self.checks)
            for status in ("pass", "warning", "fail", "skipped")
        }
        return {
            "ok": self.ok,
            "version": self.version,
            "summary": counts,
            "checks": [check.as_dict() for check in self.checks],
        }


def _is_placeholder(value: str | None) -> bool:
    if value is None:
        return False
    normalized = value.casefold().replace(" ", "_")
    return any(marker in normalized for marker in _PLACEHOLDER_MARKERS)


def _migration_digests(directory: Path) -> dict[str, str]:
    paths = sorted(directory.glob("*.sql"))
    return {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in paths}


def _origin(value: str) -> tuple[str, str] | None:
    parsed = urlsplit(value)
    if not public_http_url_is_structurally_safe(value):
        return None
    return parsed.scheme, parsed.netloc.casefold()


def _configuration_checks(settings: Settings) -> list[DoctorCheck]:
    checks: list[DoctorCheck] = []
    sensitive_values = {
        "STRIPE_SECRET_KEY": settings.stripe_secret_key,
        "STRIPE_WEBHOOK_SECRET": settings.stripe_webhook_secret,
        "DEMO_BEARER_TOKEN": settings.demo_bearer_token,
    }
    placeholders = sorted(
        field for field, value in sensitive_values.items() if _is_placeholder(value)
    )
    if placeholders:
        checks.append(
            DoctorCheck(
                "config.placeholders",
                "fail",
                "placeholder value detected in: " + ", ".join(placeholders),
            )
        )
    else:
        checks.append(
            DoctorCheck("config.placeholders", "pass", "no known secret placeholders detected")
        )

    mode = "live" if settings.stripe_secret_key.startswith("sk_live_") else "test"
    if not settings.stripe_secret_key.startswith(("sk_test_", "sk_live_")):
        checks.append(DoctorCheck("stripe.mode", "fail", "secret-key mode is invalid"))
    elif mode == "live" and settings.app_env == "development":
        checks.append(
            DoctorCheck(
                "stripe.mode",
                "warning",
                "live Stripe credentials are paired with APP_ENV=development; "
                "demo auth remains disabled",
            )
        )
    else:
        checks.append(DoctorCheck("stripe.mode", "pass", f"configuration selects {mode} mode"))

    portal_id = settings.stripe_portal_configuration_id
    if portal_id is None:
        checks.append(
            DoctorCheck(
                "stripe.portal_configuration",
                "fail",
                "STRIPE_PORTAL_CONFIGURATION_ID is required for Portal sessions",
            )
        )
    elif _is_placeholder(portal_id):
        checks.append(
            DoctorCheck(
                "stripe.portal_configuration",
                "fail",
                "Portal configuration ID is still a placeholder",
            )
        )
    elif not portal_id.startswith("bpc_"):
        checks.append(
            DoctorCheck(
                "stripe.portal_configuration", "fail", "Portal configuration ID format is invalid"
            )
        )
    else:
        checks.append(
            DoctorCheck(
                "stripe.portal_configuration", "pass", "Portal configuration ID format is valid"
            )
        )

    versions_valid = bool(
        _VERSION.fullmatch(settings.stripe_api_version)
        and _VERSION.fullmatch(settings.stripe_webhook_api_version)
    )
    if versions_valid:
        checks.append(
            DoctorCheck(
                "stripe.version_contracts",
                "pass",
                "outbound request and signed webhook snapshot versions are configured "
                "independently; "
                "this local check does not verify an endpoint payload",
            )
        )
    else:
        checks.append(
            DoctorCheck(
                "stripe.version_contracts", "fail", "one or both Stripe version formats are invalid"
            )
        )

    urls = (
        settings.checkout_success_url,
        settings.checkout_cancel_url,
        settings.portal_return_url,
    )
    origins = tuple(
        origin.strip().rstrip("/")
        for origin in settings.frontend_origins.split(",")
        if origin.strip()
    )
    url_contract_valid = bool(
        all(public_http_url_is_structurally_safe(value) for value in urls)
        and checkout_success_base_url_is_safe(settings.checkout_success_url)
    )
    cors_valid = bool(origins) and "*" not in origins
    for value in origins:
        parsed = urlsplit(value)
        cors_valid = bool(
            cors_valid
            and _origin(value) is not None
            and parsed.path in {"", "/"}
            and not parsed.query
            and not parsed.fragment
        )
    if mode == "live":
        all_public_values = (*urls, *origins)
        url_contract_valid = bool(
            url_contract_valid
            and all(urlsplit(value).scheme == "https" for value in all_public_values)
            and all(
                (urlsplit(value).hostname or "").casefold() not in {"localhost", "127.0.0.1", "::1"}
                for value in all_public_values
            )
        )
    if url_contract_valid and cors_valid:
        checks.append(
            DoctorCheck(
                "http.urls_and_cors",
                "pass",
                f"configured URLs and {len(origins)} credentialed CORS origin(s) "
                "are structurally safe",
            )
        )
    else:
        checks.append(
            DoctorCheck(
                "http.urls_and_cors",
                "fail",
                "URL/CORS contract is invalid for the configured Stripe mode",
            )
        )
    return checks


def _value(obj: Any, field: str) -> Any:
    if isinstance(obj, Mapping):
        return obj.get(field)
    return getattr(obj, field, None)


def _stripe_mapping(value: Any) -> Mapping[str, Any]:
    if isinstance(value, Mapping):
        return value
    converter = getattr(value, "to_dict_recursive", None)
    converted = converter() if callable(converter) else getattr(value, "__dict__", None)
    if not isinstance(converted, Mapping):
        raise RuntimeError("Stripe returned a non-object catalog entry")
    return converted


async def _stripe_network_checks(
    settings: Settings,
    catalog: PlanCatalog | None,
    *,
    enabled: bool,
) -> list[DoctorCheck]:
    if not enabled:
        return [
            DoctorCheck(
                "stripe.network",
                "skipped",
                "not requested; no Stripe API request was made (use --stripe-network)",
            ),
            DoctorCheck(
                "stripe.webhook_endpoint",
                "skipped",
                "no endpoint ID is configured; version configuration is not delivery evidence",
            ),
            DoctorCheck(
                "stripe.network.catalog",
                "skipped",
                "not requested; Stripe catalog inventory was not read",
            ),
        ]
    if _is_placeholder(settings.stripe_secret_key):
        return [
            DoctorCheck(
                "stripe.network",
                "skipped",
                "network verification refused because the Stripe key is a placeholder",
            ),
            DoctorCheck(
                "stripe.webhook_endpoint",
                "skipped",
                "no endpoint ID is configured; version configuration is not delivery evidence",
            ),
            DoctorCheck(
                "stripe.network.catalog",
                "skipped",
                "catalog inventory verification refused for a placeholder key",
            ),
        ]
    checks: list[DoctorCheck] = []

    def retrieve_account() -> Any:
        return stripe.Account.retrieve(
            api_key=settings.stripe_secret_key,
            stripe_version=settings.stripe_api_version,
        )

    try:
        await asyncio.to_thread(retrieve_account)
    except Exception as exc:
        checks.append(
            DoctorCheck(
                "stripe.network.account",
                "fail",
                f"read-only account retrieval failed ({type(exc).__name__})",
            )
        )
    else:
        checks.append(
            DoctorCheck("stripe.network.account", "pass", "read-only account retrieval succeeded")
        )

    if catalog is None:
        checks.append(
            DoctorCheck(
                "stripe.network.catalog",
                "skipped",
                "local catalog validation failed, so remote inventory was not checked",
            )
        )
    else:

        def verify_catalog_inventory() -> tuple[int, int]:
            recurring_count = 0
            pack_count = 0
            request_options: dict[str, Any] = {
                "api_key": settings.stripe_secret_key,
                "stripe_version": settings.stripe_api_version,
            }
            for plan in catalog.ordered():
                for interval, major_amount in (
                    ("month", plan.month_usd),
                    ("year", plan.year_usd),
                ):
                    lookup_key = catalog.lookup_key(plan.key, interval)
                    prices = stripe.Price.list(
                        lookup_keys=[lookup_key],
                        active=True,
                        limit=2,
                        expand=["data.currency_options", "data.product"],
                        **request_options,
                    )
                    data = _value(prices, "data")
                    if not isinstance(data, list) or len(data) != 1:
                        raise RuntimeError("Stripe recurring catalog cardinality drift")
                    price = _stripe_mapping(data[0])
                    if not catalog_price_matches(
                        price,
                        expected_currency=plan.currency,
                        expected_unit_amount=major_amount * 100,
                        expected_interval=interval,
                        expected_product_line=settings.product_line,
                        expected_plan_key=plan.key,
                        expected_lookup_key=lookup_key,
                    ):
                        raise RuntimeError("Stripe recurring catalog contract drift")
                    recurring_count += 1
            for pack in catalog.ordered_credit_packs():
                lookup_key = catalog.credit_pack_lookup_key(pack.key)
                prices = stripe.Price.list(
                    lookup_keys=[lookup_key],
                    active=True,
                    limit=2,
                    expand=["data.currency_options", "data.product"],
                    **request_options,
                )
                data = _value(prices, "data")
                if not isinstance(data, list) or len(data) != 1:
                    raise RuntimeError("Stripe credit-pack catalog cardinality drift")
                price = _stripe_mapping(data[0])
                if not catalog_one_time_price_matches(
                    price,
                    expected_currency=pack.currency,
                    expected_unit_amount=pack.price_usd * 100,
                    expected_product_line=settings.product_line,
                    expected_pack_key=pack.key,
                    expected_lookup_key=lookup_key,
                ):
                    raise RuntimeError("Stripe credit-pack catalog contract drift")
                pack_count += 1
            return recurring_count, pack_count

        try:
            recurring_count, pack_count = await asyncio.to_thread(verify_catalog_inventory)
        except Exception as exc:
            checks.append(
                DoctorCheck(
                    "stripe.network.catalog",
                    "fail",
                    f"read-only Stripe catalog verification failed ({type(exc).__name__})",
                )
            )
        else:
            checks.append(
                DoctorCheck(
                    "stripe.network.catalog",
                    "pass",
                    f"{recurring_count} recurring and {pack_count} one-time "
                    "Price contract(s) match",
                )
            )

    portal_id = settings.stripe_portal_configuration_id
    if portal_id is None or _is_placeholder(portal_id):
        checks.append(
            DoctorCheck(
                "stripe.network.portal",
                "skipped",
                "Portal retrieval requires a non-placeholder configuration ID",
            )
        )
    else:

        def retrieve_portal() -> Any:
            return stripe.billing_portal.Configuration.retrieve(
                portal_id,
                api_key=settings.stripe_secret_key,
                stripe_version=settings.stripe_api_version,
            )

        try:
            portal = await asyncio.to_thread(retrieve_portal)
            portal_raw = _stripe_mapping(portal)
            expected_livemode = settings.stripe_secret_key.startswith("sk_live_")
            valid = bool(
                portal_raw.get("id") == portal_id
                and portal_configuration_is_safe(
                    portal_raw,
                    expected_livemode=expected_livemode,
                    expected_product_line=settings.product_line,
                )
            )
        except Exception as exc:
            checks.append(
                DoctorCheck(
                    "stripe.network.portal",
                    "fail",
                    f"read-only Portal retrieval failed ({type(exc).__name__})",
                )
            )
        else:
            checks.append(
                DoctorCheck(
                    "stripe.network.portal",
                    "pass" if valid else "fail",
                    (
                        "Portal identity and mode match; subscription updates are disabled "
                        "and cancellation is limited to period end"
                        if valid
                        else "Portal identity or safety policy does not match; subscription "
                        "updates must be disabled and cancellation must be limited to period end"
                    ),
                )
            )
    checks.append(
        DoctorCheck(
            "stripe.webhook_endpoint",
            "skipped",
            "no endpoint ID is configured; signed payload version still requires "
            "deployment evidence",
        )
    )
    return checks


async def run_doctor(
    settings: Settings | None = None,
    *,
    stripe_network: bool = False,
) -> DoctorReport:
    """Run read-only local, PostgreSQL and optionally Stripe GET-only checks.

    Error messages deliberately expose only exception class names. Configuration values,
    DSNs, Stripe identifiers and SDK exception messages are never rendered.
    """

    checks: list[DoctorCheck] = []
    try:
        installed = distribution_version("stripe-entitlements-fastapi")
    except PackageNotFoundError:
        checks.append(
            DoctorCheck(
                "package.version",
                "warning",
                f"source version is {__version__}; installed distribution metadata is unavailable",
            )
        )
    else:
        checks.append(
            DoctorCheck(
                "package.version",
                "pass" if installed == __version__ else "fail",
                (
                    f"package and source versions agree at {__version__}"
                    if installed == __version__
                    else "package and source versions do not agree"
                ),
            )
        )

    migration_digests: dict[str, str] | None = None
    try:
        migration_digests = await asyncio.to_thread(
            _migration_digests, default_migration_directory()
        )
        if not migration_digests:
            raise RuntimeError("empty migration bundle")
    except Exception as exc:
        checks.append(
            DoctorCheck(
                "package.migrations",
                "fail",
                f"bundled migrations are unavailable ({type(exc).__name__})",
            )
        )
    else:
        checks.append(
            DoctorCheck(
                "package.migrations",
                "pass",
                f"{len(migration_digests)} bundled migration(s) are readable",
            )
        )

    if settings is None:
        try:
            settings = get_settings()
        except Exception as exc:
            checks.append(
                DoctorCheck(
                    "config.load",
                    "fail",
                    f"configuration validation failed ({type(exc).__name__})",
                )
            )
            checks.extend(
                (
                    DoctorCheck("catalog.load", "skipped", "configuration is unavailable"),
                    DoctorCheck("database.connection", "skipped", "configuration is unavailable"),
                    DoctorCheck("database.schema", "skipped", "database was not checked"),
                    DoctorCheck(
                        "database.migration_checksums",
                        "skipped",
                        "database was not checked",
                    ),
                    DoctorCheck("stripe.network", "skipped", "configuration is unavailable"),
                    DoctorCheck(
                        "stripe.webhook_endpoint",
                        "skipped",
                        "configuration is unavailable and no delivery evidence was checked",
                    ),
                )
            )
            return DoctorReport(__version__, tuple(checks))

    checks.append(DoctorCheck("config.load", "pass", "typed configuration loaded"))
    checks.extend(_configuration_checks(settings))

    catalog: PlanCatalog | None = None
    try:
        catalog = PlanCatalog.from_toml(settings.plan_catalog_path, settings.lookup_prefix)
    except Exception as exc:
        checks.append(
            DoctorCheck(
                "catalog.load",
                "fail",
                f"catalog validation failed ({type(exc).__name__})",
            )
        )
    else:
        checks.append(
            DoctorCheck(
                "catalog.load",
                "pass",
                f"catalog contains {len(catalog.plans)} validated plan(s)",
            )
        )

    database = Database.from_settings(settings)
    connected = False
    try:
        await database.connect()
        connected = True
        async with database.require_pool().acquire() as conn:
            await conn.fetchval("select 1")
        checks.append(DoctorCheck("database.connection", "pass", "PostgreSQL is reachable"))
    except Exception as exc:
        checks.append(
            DoctorCheck(
                "database.connection",
                "fail",
                f"PostgreSQL connection failed ({type(exc).__name__})",
            )
        )

    if connected:
        try:
            ready = await database.schema_ready()
        except Exception as exc:
            checks.append(
                DoctorCheck(
                    "database.schema",
                    "fail",
                    f"schema readiness check failed ({type(exc).__name__})",
                )
            )
        else:
            checks.append(
                DoctorCheck(
                    "database.schema",
                    "pass" if ready else "fail",
                    "bundled schema is ready" if ready else "schema is not ready; run migrate",
                )
            )

        if migration_digests is None:
            checks.append(
                DoctorCheck(
                    "database.migration_checksums",
                    "skipped",
                    "bundled migration digests are unavailable",
                )
            )
        else:
            try:
                async with database.require_pool().acquire() as conn:
                    history_exists = await conn.fetchval(
                        "select to_regclass('public.schema_migrations') is not null"
                    )
                    rows = (
                        await conn.fetch("select filename,sha256 from schema_migrations")
                        if history_exists
                        else []
                    )
                applied = {str(row["filename"]): str(row["sha256"]) for row in rows}
                missing = sorted(set(migration_digests) - set(applied))
                changed = sorted(
                    name
                    for name, digest in migration_digests.items()
                    if name in applied and applied[name] != digest
                )
                valid = bool(history_exists and not missing and not changed)
            except Exception as exc:
                checks.append(
                    DoctorCheck(
                        "database.migration_checksums",
                        "fail",
                        f"migration history check failed ({type(exc).__name__})",
                    )
                )
            else:
                checks.append(
                    DoctorCheck(
                        "database.migration_checksums",
                        "pass" if valid else "fail",
                        (
                            "all bundled migration checksums match applied history"
                            if valid
                            else "migration history is missing or has a checksum mismatch"
                        ),
                    )
                )
    else:
        checks.extend(
            (
                DoctorCheck("database.schema", "skipped", "database connection failed"),
                DoctorCheck(
                    "database.migration_checksums", "skipped", "database connection failed"
                ),
            )
        )
    if connected:
        await database.close()

    checks.extend(await _stripe_network_checks(settings, catalog, enabled=stripe_network))
    return DoctorReport(__version__, tuple(checks))
