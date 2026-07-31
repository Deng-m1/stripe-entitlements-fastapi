from __future__ import annotations

import argparse
import asyncio
from pathlib import Path

from .annual import AnnualGrantService
from .catalog import PlanCatalog
from .config import get_settings
from .database import Database
from .processor import EventProcessor
from .reconcile import ReconciliationService
from .stripe_gateway import StripeGateway


async def _migrate() -> None:
    settings = get_settings()
    db = Database(settings.database_url)
    await db.connect()
    try:
        await db.apply_migrations(Path("migrations"))
    finally:
        await db.close()


async def _grant_due() -> None:
    from datetime import UTC, datetime

    settings = get_settings()
    db = Database(settings.database_url)
    await db.connect()
    try:
        catalog = PlanCatalog.from_toml(settings.plan_catalog_path, settings.lookup_prefix)
        processor = EventProcessor(db.require_pool(), catalog, settings.product_line)
        service = AnnualGrantService(db.require_pool(), catalog, processor)
        gateway = StripeGateway(settings.stripe_secret_key, settings.stripe_webhook_secret)
        for candidate in await service.due_accounts(datetime.now(UTC)):
            snapshot = await gateway.subscription_snapshot(candidate["stripe_subscription_id"])
            result = await service.grant_due(str(candidate["id"]), datetime.now(UTC), snapshot)
            print(candidate["id"], result.outcome, result.reason or "")
    finally:
        await db.close()


async def _reconcile() -> None:
    from datetime import UTC, datetime

    settings = get_settings()
    db = Database(settings.database_url)
    await db.connect()
    try:
        catalog = PlanCatalog.from_toml(settings.plan_catalog_path, settings.lookup_prefix)
        processor = EventProcessor(db.require_pool(), catalog, settings.product_line)
        gateway = StripeGateway(
            settings.stripe_secret_key,
            settings.stripe_webhook_secret,
            settings.product_line,
        )
        service = ReconciliationService(db.require_pool(), processor, gateway)
        for candidate in await service.candidates(datetime.now(UTC)):
            result = await service.reconcile_account(str(candidate["id"]))
            print(candidate["id"], result.outcome, result.reason or "")
    finally:
        await db.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Stripe entitlements operations")
    parser.add_argument("command", choices=["migrate", "grant-due", "reconcile"])
    args = parser.parse_args()
    commands = {"migrate": _migrate, "grant-due": _grant_due, "reconcile": _reconcile}
    asyncio.run(commands[args.command]())


if __name__ == "__main__":
    main()
