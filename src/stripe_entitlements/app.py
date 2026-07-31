from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Header, Request
from fastapi.responses import JSONResponse

from .catalog import PlanCatalog
from .config import Settings, get_settings
from .database import Database
from .processor import EventProcessor
from .stripe_gateway import StripeGateway


def create_app(
    settings: Settings | None = None,
    *,
    database: Database | None = None,
    gateway: StripeGateway | None = None,
) -> FastAPI:
    settings = settings or get_settings()
    database = database or Database(settings.database_url)
    gateway = gateway or StripeGateway(
        settings.stripe_secret_key,
        settings.stripe_webhook_secret,
        settings.product_line,
    )
    catalog = PlanCatalog.from_toml(settings.plan_catalog_path, settings.lookup_prefix)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        logging.basicConfig(level=settings.log_level)
        if database.pool is None:
            await database.connect()
        app.state.database = database
        app.state.gateway = gateway
        app.state.processor = EventProcessor(
            database.require_pool(), catalog, settings.product_line
        )
        yield
        await database.close()

    app = FastAPI(
        title="Stripe Entitlements Reference",
        version="0.1.0",
        lifespan=lifespan,
    )

    @app.get("/health")
    async def health() -> dict[str, object]:
        async with database.require_pool().acquire() as conn:
            await conn.fetchval("select 1")
        return {"ok": True, "database": True}

    @app.post("/webhooks/stripe")
    async def stripe_webhook(
        request: Request,
        stripe_signature: str = Header(default="", alias="Stripe-Signature"),
    ) -> JSONResponse:
        payload = await request.body()
        try:
            event = gateway.construct_event(payload, stripe_signature)
        except Exception as exc:
            return JSONResponse({"error": "invalid Stripe signature", "detail": str(exc)}, 400)
        try:
            prepared = await gateway.prepare_event(event)
            result = await app.state.processor.process(prepared)
        except Exception:
            logging.getLogger("stripe_entitlements.webhook").exception(
                "stripe.webhook.failed",
                extra={"stripe_event_id": event.get("id"), "stripe_event_type": event.get("type")},
            )
            return JSONResponse({"error": "processing failed; Stripe should retry"}, 500)
        return JSONResponse(
            {
                "received": True,
                "outcome": result.outcome,
                "reason": result.reason,
                "account_id": result.account_id,
            }
        )

    return app
