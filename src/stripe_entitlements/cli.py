from __future__ import annotations

import argparse
import asyncio
import json
import sys
from collections.abc import Awaitable, Callable, Mapping
from typing import Any

import asyncpg

from . import __version__
from .annual import AnnualGrantService
from .catalog import PlanCatalog
from .config import Settings, get_settings
from .database import Database
from .doctor import run_doctor
from .processor import EventProcessor
from .reconcile import ReconciliationService
from .resources import default_migration_directory
from .stripe_gateway import StripeGateway
from .types import ProcessResult


def _event_processor(
    pool: asyncpg.Pool, catalog: PlanCatalog, settings: Settings
) -> EventProcessor:
    return EventProcessor(
        pool,
        catalog,
        settings.product_line,
        expected_livemode=settings.stripe_secret_key.startswith("sk_live_"),
        expected_api_version=settings.stripe_webhook_api_version,
    )


async def _run_candidate_batch(
    candidates: list[dict[str, Any]],
    operation: Callable[[Mapping[str, Any]], Awaitable[ProcessResult]],
) -> int:
    failures = 0
    for candidate in candidates:
        try:
            result = await operation(candidate)
            print(candidate["id"], result.outcome, result.reason or "")
        except Exception as exc:
            failures += 1
            print(candidate["id"], "failed", type(exc).__name__, file=sys.stderr)
    return failures


async def _migrate() -> None:
    settings = get_settings()
    db = Database(settings.database_url)
    await db.connect()
    try:
        await db.apply_migrations(default_migration_directory())
    finally:
        await db.close()


async def _grant_due() -> None:
    settings = get_settings()
    db = Database(settings.database_url)
    await db.connect()
    try:
        catalog = PlanCatalog.from_toml(settings.plan_catalog_path, settings.lookup_prefix)
        processor = _event_processor(db.require_pool(), catalog, settings)
        service = AnnualGrantService(db.require_pool(), catalog, processor)
        gateway = StripeGateway(
            settings.stripe_secret_key,
            settings.stripe_webhook_secret,
            settings.product_line,
            api_version=settings.stripe_api_version,
        )
        attempted: set[str] = set()
        failures = 0
        while True:
            candidates = await service.due_accounts(
                None,
                exclude_account_ids=attempted,
            )
            if not candidates:
                break
            attempted.update(str(candidate["id"]) for candidate in candidates)

            async def grant(candidate: Mapping[str, Any]) -> ProcessResult:
                account_id = str(candidate["id"])
                subscription_id = str(candidate["stripe_subscription_id"])
                try:
                    snapshot = await gateway.subscription_snapshot(subscription_id)
                except Exception as exc:
                    await service.record_failure(
                        account_id,
                        subscription_id,
                        f"subscription snapshot failed: {type(exc).__name__}",
                    )
                    raise
                return await service.grant_due(account_id, None, snapshot)

            failures += await _run_candidate_batch(candidates, grant)
        if failures:
            raise RuntimeError(f"annual grant batch completed with {failures} failure(s)")
    finally:
        await db.close()


async def _reconcile() -> None:
    settings = get_settings()
    db = Database(settings.database_url)
    await db.connect()
    try:
        catalog = PlanCatalog.from_toml(settings.plan_catalog_path, settings.lookup_prefix)
        processor = _event_processor(db.require_pool(), catalog, settings)
        gateway = StripeGateway(
            settings.stripe_secret_key,
            settings.stripe_webhook_secret,
            settings.product_line,
            api_version=settings.stripe_api_version,
        )
        service = ReconciliationService(db.require_pool(), processor, gateway)
        run_started = await service.database_now()
        attempted: set[str] = set()
        failures = 0
        while True:
            candidates = await service.candidates(
                None,
                attempted_before=run_started,
                exclude_account_ids=attempted,
            )
            if not candidates:
                break
            attempted.update(str(candidate["id"]) for candidate in candidates)

            async def reconcile(candidate: Mapping[str, Any]) -> ProcessResult:
                return await service.reconcile_account(str(candidate["id"]))

            failures += await _run_candidate_batch(candidates, reconcile)
        if failures:
            raise RuntimeError(f"reconciliation completed with {failures} failure(s)")
    finally:
        await db.close()


async def _doctor(*, json_output: bool = False, stripe_network: bool = False) -> int:
    report = await run_doctor(stripe_network=stripe_network)
    if json_output:
        print(json.dumps(report.as_dict(), ensure_ascii=False, sort_keys=True))
    else:
        labels = {"pass": "PASS", "warning": "WARN", "fail": "FAIL", "skipped": "SKIP"}
        for check in report.checks:
            print(f"{labels[check.status]:4} {check.name}: {check.summary}")
        summary = report.as_dict()["summary"]
        assert isinstance(summary, dict)
        print(
            "doctor summary: "
            f"pass={summary['pass']} warning={summary['warning']} "
            f"fail={summary['fail']} skipped={summary['skipped']}"
        )
    return 0 if report.ok else 1


def main() -> None:
    parser = argparse.ArgumentParser(description="Stripe entitlements operations")
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("migrate")
    subparsers.add_parser("grant-due")
    subparsers.add_parser("reconcile")
    doctor_parser = subparsers.add_parser("doctor")
    doctor_parser.add_argument("--json", action="store_true", dest="json_output")
    doctor_parser.add_argument(
        "--stripe-network",
        action="store_true",
        help="opt in to read-only Stripe Account and Portal retrieval",
    )
    args = parser.parse_args()
    commands = {"migrate": _migrate, "grant-due": _grant_due, "reconcile": _reconcile}
    if args.command == "doctor":
        exit_code = asyncio.run(
            _doctor(json_output=args.json_output, stripe_network=args.stripe_network)
        )
        if exit_code:
            raise SystemExit(exit_code)
        return
    asyncio.run(commands[args.command]())


if __name__ == "__main__":
    main()
