import hashlib
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Annotated, Any, Literal
from urllib.parse import parse_qsl, urlsplit

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from .auth import (
    AuthAccountAdapter,
    AuthenticatedIdentity,
    AuthenticationError,
    DemoBearerAuthAdapter,
    RejectAllAuthAdapter,
)
from .catalog import PlanCatalog
from .checkout import (
    CheckoutActiveSubscriptionError,
    CheckoutBusyError,
    CheckoutCoordinator,
    CheckoutCreationRejected,
)
from .config import Settings, get_settings
from .database import Database
from .plan_changes import (
    PlanChangeBusyError,
    PlanChangeConflictError,
    PlanChangeCoordinator,
    PlanChangeResult,
    PlanChangeUnavailableError,
)
from .processor import EventProcessor
from .stripe_gateway import StripeGateway


class CheckoutRequest(BaseModel):
    plan_key: str
    interval: Literal["month", "year"]
    success_url: str
    cancel_url: str


class PortalRequest(BaseModel):
    return_url: str


class PlanChangePreviewRequest(BaseModel):
    plan_key: str
    interval: Literal["month", "year"]


class PlanChangeConfirmRequest(BaseModel):
    preview_id: str


_FEATURE_LABELS = {
    "pdf_to_ppt": "PDF to PowerPoint",
    "image_to_ppt": "Image to PowerPoint",
    "batch_conversion": "Batch conversion",
    "api_access": "API access",
    "priority_queue": "Priority queue",
}
_LIMIT_PRESENTATION = {
    "max_file_mb": ("Maximum file size", "MB"),
    "max_pages_per_job": ("Maximum pages per job", "pages"),
    "concurrent_jobs": ("Concurrent jobs", "jobs"),
    "api_keys": ("API keys", "keys"),
}


def create_app(
    settings: Settings | None = None,
    *,
    database: Database | None = None,
    gateway: StripeGateway | None = None,
    auth_adapter: AuthAccountAdapter | None = None,
) -> FastAPI:
    settings = settings or get_settings()
    database = database or Database(settings.database_url)
    gateway = gateway or StripeGateway(
        settings.stripe_secret_key,
        settings.stripe_webhook_secret,
        settings.product_line,
        api_version=settings.stripe_api_version,
        portal_configuration_id=settings.stripe_portal_configuration_id,
        checkout_success_url=settings.checkout_success_url,
        checkout_cancel_url=settings.checkout_cancel_url,
        portal_return_url=settings.portal_return_url,
    )
    if auth_adapter is None:
        if (
            settings.app_env == "development"
            and settings.stripe_secret_key.startswith("sk_test_")
            and settings.demo_bearer_token
        ):
            auth_adapter = DemoBearerAuthAdapter(
                settings.demo_bearer_token,
                settings.demo_bearer_subject,
                settings.demo_bearer_email,
            )
        else:
            auth_adapter = RejectAllAuthAdapter()
    catalog = PlanCatalog.from_toml(settings.plan_catalog_path, settings.lookup_prefix)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        logging.basicConfig(level=settings.log_level)
        if database.pool is None:
            await database.connect()
        app.state.database = database
        app.state.gateway = gateway
        app.state.processor = EventProcessor(
            database.require_pool(),
            catalog,
            settings.product_line,
            expected_livemode=settings.stripe_secret_key.startswith("sk_live_"),
            expected_api_version=settings.stripe_webhook_api_version,
        )
        app.state.checkout = CheckoutCoordinator(database.require_pool())
        app.state.plan_changes = PlanChangeCoordinator(
            database.require_pool(), catalog, gateway
        )
        yield
        await database.close()

    app = FastAPI(
        title="Stripe Entitlements Reference",
        version="0.1.0",
        lifespan=lifespan,
    )
    origins = [origin.strip().rstrip("/") for origin in settings.frontend_origins.split(",")]
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[origin for origin in origins if origin],
        allow_credentials=True,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "Idempotency-Key"],
    )

    async def current_identity(request: Request) -> AuthenticatedIdentity:
        try:
            identity = await auth_adapter.authenticate(request)
        except AuthenticationError as exc:
            raise HTTPException(401, str(exc)) from exc
        if not identity.external_ref:
            raise HTTPException(401, "authenticated identity has no stable subject")
        return identity

    Identity = Annotated[AuthenticatedIdentity, Depends(current_identity)]

    async def billing_account(identity: Identity) -> dict[str, Any]:
        return await database.account_for_external_ref(identity.external_ref)

    Account = Annotated[dict[str, Any], Depends(billing_account)]

    def entitlement_rows(plan_key: str) -> list[dict[str, object]]:
        if plan_key == "free" or plan_key not in catalog.plans:
            return []
        plan = catalog.plans[plan_key]
        values: list[dict[str, object]] = [
            {
                "key": "monthly_credits",
                "label": "Credits per monthly grant",
                "value": plan.monthly_credits,
                "unit": "credits",
            }
        ]
        values.extend(
            {
                "key": feature,
                "label": _FEATURE_LABELS.get(feature, feature.replace("_", " ").title()),
                "value": True,
            }
            for feature in sorted(plan.features)
        )
        values.extend(
            {
                "key": key,
                "label": _LIMIT_PRESENTATION.get(
                    key, (key.replace("_", " ").title(), None)
                )[0],
                "value": value,
                "unit": _LIMIT_PRESENTATION.get(key, ("", None))[1],
            }
            for key, value in sorted(plan.limits.items())
        )
        return values

    async def account_response(account: dict[str, Any]) -> dict[str, Any]:
        pending = await database.pending_plan_change(str(account["id"]))
        plan = catalog.plans.get(str(account["plan_key"]))
        pending_change = None
        if pending is not None:
            effective = pending["effective_at"] or pending["created_at"]
            pending_change = {
                "preview_id": str(pending["id"]),
                "target_plan_key": pending["target_plan_key"],
                "target_interval": pending["target_interval"],
                "timing": pending["effective_mode"],
                "effective_at": effective.isoformat(),
                "status": pending["status"],
                "payment_url": pending["recovery_url"],
            }
        return {
            "plan_key": account["plan_key"],
            "plan_interval": account["plan_interval"],
            "subscription_status": account["subscription_status"],
            "current_period_end": (
                account["entitlement_period_end"].isoformat()
                if account["entitlement_period_end"]
                else None
            ),
            "observed_period_end": (
                account["current_period_end"].isoformat()
                if account["current_period_end"]
                else None
            ),
            "credits": {
                "balance": int(account["credits_balance"]),
                "grant_amount": plan.monthly_credits if plan else 0,
                "next_grant_at": (
                    account["credit_expires_at"].isoformat()
                    if account["credit_expires_at"]
                    else None
                ),
            },
            "entitlements": entitlement_rows(str(account["plan_key"])),
            "entitlements_enforceable": bool(
                account["subscription_status"] == "active"
                and not account["entitlement_revoked"]
                and account["credit_expires_at"]
                and account["credit_expires_at"] > datetime.now(UTC)
            ),
            "pending_change": pending_change,
            "pending_cancellation": (
                {
                    "target_plan_key": "free",
                    "timing": "period_end",
                    "effective_at": account["pending_free_at"].isoformat()
                    if account["pending_free_at"]
                    else None,
                }
                if account["cancel_at_period_end"]
                else None
            ),
        }

    def require_idempotency(value: str) -> str:
        if not value or len(value) > 200:
            raise HTTPException(400, "Idempotency-Key must contain 1 to 200 characters")
        return value

    def require_configured_url(value: str, expected: str, field: str) -> None:
        if value.rstrip("/") != expected.rstrip("/"):
            raise HTTPException(400, f"{field} must match the server allowlisted URL")

    def require_checkout_success_url(
        value: str, *, plan_key: str, interval: str
    ) -> None:
        supplied = urlsplit(value)
        expected = urlsplit(settings.checkout_success_url)
        if (
            (supplied.scheme, supplied.netloc, supplied.path)
            != (expected.scheme, expected.netloc, expected.path)
            or supplied.fragment
        ):
            raise HTTPException(400, "success_url must match the server allowlisted URL")
        query = dict(parse_qsl(supplied.query, keep_blank_values=True))
        if query not in (
            {},
            {"expected_plan": plan_key, "expected_interval": interval},
        ):
            raise HTTPException(400, "success_url query does not match the Checkout target")

    def plan_change_error(exc: Exception) -> HTTPException:
        if isinstance(exc, (PlanChangeBusyError, CheckoutBusyError)):
            return HTTPException(409, str(exc))
        if isinstance(exc, (PlanChangeConflictError, ValueError)):
            return HTTPException(400, str(exc))
        if isinstance(exc, PlanChangeUnavailableError):
            return HTTPException(409, str(exc))
        return HTTPException(502, "Stripe plan change failed; retry the same request")

    @app.get("/health")
    async def health() -> dict[str, object]:
        async with database.require_pool().acquire() as conn:
            await conn.fetchval("select 1")
        return {"ok": True, "database": True}

    @app.get("/api/catalog")
    @app.get("/billing/catalog", include_in_schema=False)
    async def billing_catalog(identity: Identity) -> dict[str, object]:
        del identity
        return {
            "plans": [
                {
                    "key": plan.key,
                    "name": plan.name,
                    "description": plan.description,
                    "display_order": plan.rank,
                    "prices": {
                        "month": {
                            "currency": plan.currency,
                            "unit_amount": plan.month_usd * 100,
                            "interval": "month",
                        },
                        "year": {
                            "currency": plan.currency,
                            "unit_amount": plan.year_usd * 100,
                            "interval": "year",
                        },
                    },
                    "entitlements": entitlement_rows(plan.key),
                }
                for plan in catalog.ordered()
            ]
        }

    @app.get("/api/account")
    @app.get("/billing/account", include_in_schema=False)
    async def get_billing_account(account: Account) -> dict[str, Any]:
        return await account_response(account)

    @app.post("/api/checkout")
    @app.post("/billing/checkout", include_in_schema=False)
    async def create_checkout(
        body: CheckoutRequest,
        account: Account,
        identity: Identity,
        idempotency_key: str = Header(alias="Idempotency-Key"),
    ) -> dict[str, str]:
        request_key = require_idempotency(idempotency_key)
        require_checkout_success_url(
            body.success_url, plan_key=body.plan_key, interval=body.interval
        )
        require_configured_url(body.cancel_url, settings.checkout_cancel_url, "cancel_url")
        try:
            plan = catalog.require(body.plan_key)
            session_id, url = await app.state.checkout.create(
                gateway,
                account_id=str(account["id"]),
                customer_id=account["stripe_customer_id"],
                customer_email=identity.email,
                plan_key=plan.key,
                interval=body.interval,
                lookup_key=catalog.lookup_key(plan.key, body.interval),
                expected_currency=plan.currency,
                expected_unit_amount=(
                    plan.month_usd if body.interval == "month" else plan.year_usd
                )
                * 100,
                expected_interval=body.interval,
                request_key=request_key,
            )
        except (
            CheckoutBusyError,
            CheckoutActiveSubscriptionError,
            CheckoutCreationRejected,
            ValueError,
        ) as exc:
            raise HTTPException(409, str(exc)) from exc
        del session_id
        return {"url": url}

    @app.post("/api/billing/portal")
    @app.post("/billing/portal", include_in_schema=False)
    async def create_portal(
        body: PortalRequest,
        account: Account,
        idempotency_key: str = Header(alias="Idempotency-Key"),
    ) -> dict[str, str]:
        require_configured_url(body.return_url, settings.portal_return_url, "return_url")
        if not account["stripe_customer_id"]:
            raise HTTPException(409, "account has no Stripe customer")
        digest = hashlib.sha256(require_idempotency(idempotency_key).encode()).hexdigest()
        try:
            _, url = await gateway.create_portal_session(
                customer_id=str(account["stripe_customer_id"]),
                idempotency_key=f"portal:{account['id']}:{digest}",
            )
        except Exception as exc:
            raise HTTPException(502, "Stripe Portal is temporarily unavailable") from exc
        return {"url": url}

    @app.post("/api/billing/change/preview")
    @app.post("/billing/plan-change/preview", include_in_schema=False)
    async def preview_plan_change(
        body: PlanChangePreviewRequest,
        account: Account,
        idempotency_key: str = Header(alias="Idempotency-Key"),
    ) -> dict[str, Any]:
        try:
            result: PlanChangeResult = await app.state.plan_changes.preview_remote(
                str(account["id"]),
                body.plan_key,
                body.interval,
                require_idempotency(idempotency_key),
            )
        except Exception as exc:
            raise plan_change_error(exc) from exc
        if result.decision.timing == "noop":
            raise HTTPException(409, "plan and interval are unchanged")
        target = catalog.require(result.decision.target_plan)
        effective = result.effective_at or datetime.now(UTC)
        return {
            "preview_id": result.change_id,
            "current_plan_key": result.decision.from_plan,
            "current_interval": result.decision.from_interval,
            "target_plan_key": result.decision.target_plan,
            "target_interval": result.decision.target_interval,
            "timing": result.decision.timing,
            "effective_at": effective.isoformat(),
            "currency": result.estimate_currency or target.currency,
            "amount_due_now": (
                result.estimated_amount_due or 0
                if result.decision.timing == "immediate"
                else 0
            ),
            "credit_applied": (
                result.estimated_credit_applied or 0
                if result.decision.timing == "immediate"
                else 0
            ),
            "next_invoice_amount": (
                target.month_usd if result.decision.target_interval == "month" else target.year_usd
            )
            * 100,
        }

    @app.post("/api/billing/change/confirm")
    @app.post("/billing/plan-change/confirm", include_in_schema=False)
    async def confirm_plan_change(
        body: PlanChangeConfirmRequest,
        account: Account,
    ) -> dict[str, Any]:
        try:
            result: PlanChangeResult = await app.state.plan_changes.confirm(
                str(account["id"]), body.preview_id
            )
        except Exception as exc:
            raise plan_change_error(exc) from exc
        if result.status == "previewed":
            raise HTTPException(409, "this preview is currently being confirmed")
        response_status = "confirmed"
        if result.status == "requires_action":
            response_status = "action_required" if result.client_secret else "payment_required"
        payload: dict[str, Any] = {
            "status": response_status,
            "timing": result.decision.timing,
            "target_plan_key": result.decision.target_plan,
            "target_interval": result.decision.target_interval,
        }
        if result.recovery_url:
            payload["payment_url"] = result.recovery_url
        if result.client_secret:
            payload["payment_client_secret"] = result.client_secret
            payload["payment_confirmation_method"] = "confirm_payment"
        if result.status in {"completed", "scheduled"}:
            refreshed = await database.account(str(account["id"]))
            if refreshed is not None:
                payload["account"] = await account_response(refreshed)
        return payload

    @app.post("/webhooks/stripe")
    async def stripe_webhook(
        request: Request,
        stripe_signature: str = Header(default="", alias="Stripe-Signature"),
    ) -> JSONResponse:
        payload = await request.body()
        try:
            event = gateway.construct_event(payload, stripe_signature)
        except Exception as exc:
            del exc
            return JSONResponse({"error": "invalid Stripe signature"}, 400)
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
