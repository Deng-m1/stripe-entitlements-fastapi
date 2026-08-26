import logging
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Annotated, Any, Literal
from urllib.parse import parse_qsl, urlsplit
from uuid import UUID

from fastapi import Depends, FastAPI, Header, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

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


class _StrictRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CheckoutRequest(_StrictRequest):
    plan_key: Annotated[str, Field(min_length=1, max_length=64)]
    interval: Literal["month", "year"]
    success_url: Annotated[str, Field(min_length=1, max_length=2048)]
    cancel_url: Annotated[str, Field(min_length=1, max_length=2048)]


class PortalRequest(_StrictRequest):
    return_url: Annotated[str, Field(min_length=1, max_length=2048)]


class PlanChangePreviewRequest(_StrictRequest):
    plan_key: Annotated[str, Field(min_length=1, max_length=64)]
    interval: Literal["month", "year"]


class PlanChangeConfirmRequest(_StrictRequest):
    preview_id: UUID


_FEATURE_LABELS = {
    "pdf_to_ppt": "PDF to PowerPoint",
    "image_to_ppt": "Image to PowerPoint",
    "batch_conversion": "Batch conversion",
    "api_access": "API access",
    "priority_queue": "Priority queue",
}
_MAX_STRIPE_WEBHOOK_BYTES = 1_048_576

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
        allow_promotion_codes=settings.checkout_allow_promotion_codes,
    )
    gateway_secret_key = getattr(gateway, "secret_key", "")
    if not isinstance(gateway_secret_key, str) or not gateway_secret_key.startswith(
        ("sk_test_", "sk_live_")
    ):
        raise ValueError("billing gateway must expose an sk_test_ or sk_live_ secret key")
    if not settings.stripe_secret_key.startswith(("sk_test_", "sk_live_")):
        raise ValueError("configured Stripe key must be an sk_test_ or sk_live_ secret key")
    settings_test_mode = settings.stripe_secret_key.startswith("sk_test_")
    gateway_test_mode = gateway_secret_key.startswith("sk_test_")
    if settings_test_mode != gateway_test_mode:
        raise ValueError("settings and billing gateway Stripe modes do not match")
    if not settings.stripe_webhook_secret.startswith("whsec_"):
        raise ValueError("Stripe webhook secret must start with whsec_")
    origins = [origin.strip().rstrip("/") for origin in settings.frontend_origins.split(",")]
    origins = [origin for origin in origins if origin]
    if "*" in origins:
        raise ValueError("credentialed billing CORS cannot allow a wildcard origin")
    for origin in origins:
        parsed_origin = urlsplit(origin)
        if (
            parsed_origin.scheme not in {"http", "https"}
            or not parsed_origin.netloc
            or parsed_origin.username is not None
            or parsed_origin.password is not None
            or parsed_origin.path not in {"", "/"}
            or parsed_origin.query
            or parsed_origin.fragment
        ):
            raise ValueError("FRONTEND_ORIGINS entries must be bare HTTP(S) origins")
    if not gateway_test_mode:
        public_urls = {
            "CHECKOUT_SUCCESS_URL": settings.checkout_success_url,
            "CHECKOUT_CANCEL_URL": settings.checkout_cancel_url,
            "PORTAL_RETURN_URL": settings.portal_return_url,
            **{f"FRONTEND_ORIGINS[{index}]": origin for index, origin in enumerate(origins)},
        }
        for field, value in public_urls.items():
            parsed = urlsplit(value)
            if (
                parsed.scheme != "https"
                or not parsed.netloc
                or parsed.username is not None
                or parsed.password is not None
                or parsed.fragment
            ):
                raise ValueError(f"{field} must be an origin-safe HTTPS URL in live mode")
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
        connected_here = database.pool is None
        if connected_here:
            await database.connect()
        try:
            app.state.database = database
            app.state.gateway = gateway
            app.state.processor = EventProcessor(
                database.require_pool(),
                catalog,
                settings.product_line,
                expected_livemode=not gateway_test_mode,
                expected_api_version=settings.stripe_webhook_api_version,
            )
            app.state.checkout = CheckoutCoordinator(database.require_pool())
            app.state.plan_changes = PlanChangeCoordinator(
                database.require_pool(),
                catalog,
                gateway,
                transition_policy=settings.billing_transition_policy,
            )
            yield
        finally:
            if connected_here:
                await database.close()

    app = FastAPI(
        title="Stripe Entitlements Reference",
        version="0.2.2",
        lifespan=lifespan,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=[
            "Authorization",
            "Content-Type",
            "Idempotency-Key",
            "X-Stripe-Mode-Requirement",
        ],
    )

    protected_origins = frozenset(origins)

    def harden_billing_response(path: str, response: Response) -> Response:
        if path.startswith(("/api/", "/billing/", "/webhooks/")):
            response.headers["Cache-Control"] = "no-store"
            response.headers["Pragma"] = "no-cache"
            response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @app.middleware("http")
    async def billing_response_headers(
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        path = request.url.path
        origin = request.headers.get("Origin")
        if (
            request.method in {"POST", "PUT", "PATCH", "DELETE"}
            and path.startswith(("/api/", "/billing/"))
            and origin is not None
            and origin not in protected_origins
        ):
            return harden_billing_response(
                path,
                JSONResponse({"error": "request origin is not allowed"}, status_code=403),
            )
        response = await call_next(request)
        return harden_billing_response(path, response)

    async def current_identity(request: Request) -> AuthenticatedIdentity:
        try:
            identity = await auth_adapter.authenticate(request)
        except AuthenticationError as exc:
            raise HTTPException(401, "authentication failed") from exc
        external_ref = identity.external_ref
        if (
            not external_ref
            or external_ref != external_ref.strip()
            or len(external_ref.encode("utf-8")) > 512
            or any(not character.isprintable() for character in external_ref)
        ):
            raise HTTPException(401, "authenticated identity has an invalid stable subject")
        if identity.email is not None and (
            identity.email != identity.email.strip()
            or len(identity.email.encode("utf-8")) > 320
            or identity.email.count("@") != 1
            or any(
                character.isspace() or not character.isprintable() for character in identity.email
            )
        ):
            raise HTTPException(401, "authenticated identity has an invalid email")
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
                "label": _LIMIT_PRESENTATION.get(key, (key.replace("_", " ").title(), None))[0],
                "value": value,
                "unit": _LIMIT_PRESENTATION.get(key, ("", None))[1],
            }
            for key, value in sorted(plan.limits.items())
        )
        return values

    async def account_response(account: dict[str, Any]) -> dict[str, Any]:
        pending = await database.pending_plan_change(str(account["id"]))
        plan = catalog.plans.get(str(account["plan_key"]))
        database_now = account.get("database_now")
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
                "transition_policy": pending["transition_policy"],
            }
        return {
            "account_id": str(account["id"]),
            "transition_policy": settings.billing_transition_policy,
            "plan_key": account["plan_key"],
            "plan_interval": account["plan_interval"],
            "subscription_status": account["subscription_status"],
            "current_period_end": (
                account["entitlement_period_end"].isoformat()
                if account["entitlement_period_end"]
                else None
            ),
            "observed_period_end": (
                account["current_period_end"].isoformat() if account["current_period_end"] else None
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
                and isinstance(database_now, datetime)
                and account["credit_expires_at"] > database_now
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
        if (
            not value
            or value != value.strip()
            or len(value.encode("utf-8")) > 200
            or any(ord(character) < 32 for character in value)
        ):
            raise HTTPException(
                400,
                "Idempotency-Key must contain 1 to 200 visible characters without padding",
            )
        return value

    def require_configured_url(value: str, expected: str, field: str) -> None:
        if value.rstrip("/") != expected.rstrip("/"):
            raise HTTPException(400, f"{field} must match the server allowlisted URL")

    def require_checkout_success_url(value: str, *, plan_key: str, interval: str) -> None:
        supplied = urlsplit(value)
        expected = urlsplit(settings.checkout_success_url)
        if (supplied.scheme, supplied.netloc, supplied.path) != (
            expected.scheme,
            expected.netloc,
            expected.path,
        ) or supplied.fragment:
            raise HTTPException(400, "success_url must match the server allowlisted URL")
        query_pairs = parse_qsl(supplied.query, keep_blank_values=True)
        if len({key for key, _ in query_pairs}) != len(query_pairs):
            raise HTTPException(400, "success_url query contains duplicate keys")
        query = dict(query_pairs)
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
    async def health(response: Response) -> dict[str, object]:
        response.headers["Cache-Control"] = "no-store"
        async with database.require_pool().acquire() as conn:
            await conn.fetchval("select 1")
        if not await database.schema_ready():
            response.status_code = 503
            return {
                "ok": False,
                "database": True,
                "schema": False,
                "stripe_mode": ("test" if gateway_test_mode else "live"),
                "transition_policy": settings.billing_transition_policy,
            }
        return {
            "ok": True,
            "database": True,
            "stripe_mode": ("test" if gateway_test_mode else "live"),
            "transition_policy": settings.billing_transition_policy,
        }

    @app.get("/api/catalog")
    @app.get("/billing/catalog", include_in_schema=False)
    async def billing_catalog(identity: Identity) -> dict[str, object]:
        del identity
        return {
            "transition_policy": settings.billing_transition_policy,
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
            ],
        }

    @app.get("/api/account")
    @app.get("/billing/account", include_in_schema=False)
    async def get_billing_account(account: Account) -> dict[str, Any]:
        return await account_response(account)

    @app.post("/api/checkout")
    @app.post("/billing/checkout", include_in_schema=False)
    async def create_checkout(
        body: CheckoutRequest,
        identity: Identity,
        idempotency_key: str = Header(alias="Idempotency-Key"),
        stripe_mode_requirement: Literal["test"] | None = Header(
            default=None, alias="X-Stripe-Mode-Requirement"
        ),
    ) -> dict[str, str]:
        if stripe_mode_requirement == "test" and not gateway_test_mode:
            raise HTTPException(409, "billing backend is not in the required Stripe test mode")
        request_key = require_idempotency(idempotency_key)
        require_checkout_success_url(
            body.success_url, plan_key=body.plan_key, interval=body.interval
        )
        require_configured_url(body.cancel_url, settings.checkout_cancel_url, "cancel_url")
        try:
            plan = catalog.require(body.plan_key)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        account = await database.account_for_external_ref(identity.external_ref)
        try:
            session_id, url = await app.state.checkout.create(
                gateway,
                account_id=str(account["id"]),
                customer_id=account["stripe_customer_id"],
                customer_email=identity.email,
                plan_key=plan.key,
                interval=body.interval,
                lookup_key=catalog.lookup_key(plan.key, body.interval),
                expected_currency=plan.currency,
                expected_unit_amount=(plan.month_usd if body.interval == "month" else plan.year_usd)
                * 100,
                expected_interval=body.interval,
                request_key=request_key,
            )
        except (
            CheckoutBusyError,
            CheckoutActiveSubscriptionError,
            CheckoutCreationRejected,
        ) as exc:
            raise HTTPException(409, str(exc)) from exc
        except Exception as exc:
            raise HTTPException(
                502, "Stripe Checkout is temporarily unavailable; retry the same request"
            ) from exc
        del session_id
        return {"url": url}

    @app.post("/api/billing/portal")
    @app.post("/billing/portal", include_in_schema=False)
    async def create_portal(
        body: PortalRequest,
        identity: Identity,
        idempotency_key: str = Header(alias="Idempotency-Key"),
    ) -> dict[str, str]:
        require_configured_url(body.return_url, settings.portal_return_url, "return_url")
        request_key = require_idempotency(idempotency_key)
        account = await database.existing_account_for_external_ref(identity.external_ref)
        if account is None or not account["stripe_customer_id"]:
            raise HTTPException(409, "account has no Stripe customer")
        try:
            _, url = await gateway.create_portal_session(
                customer_id=str(account["stripe_customer_id"]),
                idempotency_key=f"portal:{account['id']}:{request_key}",
            )
        except Exception as exc:
            raise HTTPException(502, "Stripe Portal is temporarily unavailable") from exc
        return {"url": url}

    @app.post("/api/billing/change/preview")
    @app.post("/billing/plan-change/preview", include_in_schema=False)
    async def preview_plan_change(
        body: PlanChangePreviewRequest,
        identity: Identity,
        idempotency_key: str = Header(alias="Idempotency-Key"),
    ) -> dict[str, Any]:
        request_key = require_idempotency(idempotency_key)
        try:
            catalog.require(body.plan_key)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        account = await database.existing_account_for_external_ref(identity.external_ref)
        if account is None:
            raise HTTPException(409, "an active paid subscription is required")
        try:
            result: PlanChangeResult = await app.state.plan_changes.preview_remote(
                str(account["id"]),
                body.plan_key,
                body.interval,
                request_key,
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
            "transition_policy": result.transition_policy,
            "settlement_mode": (
                "current_period_prorated_delta"
                if result.decision.timing == "immediate"
                and result.transition_policy == "prorated_delta"
                else (
                    "new_period_full_price"
                    if result.decision.timing == "immediate"
                    else "period_end"
                )
            ),
            "effective_at": effective.isoformat(),
            "currency": result.estimate_currency or target.currency,
            "amount_due_now": (
                result.estimated_amount_due or 0 if result.decision.timing == "immediate" else 0
            ),
            "credit_applied": (
                result.estimated_credit_applied or 0 if result.decision.timing == "immediate" else 0
            ),
            "entitlement_credit_delta": (
                result.entitlement_credit_delta
                if result.decision.timing == "immediate"
                and result.transition_policy == "prorated_delta"
                else None
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
        identity: Identity,
    ) -> dict[str, Any]:
        account = await database.existing_account_for_external_ref(identity.external_ref)
        if account is None:
            raise HTTPException(409, "plan-change preview not found")
        try:
            result: PlanChangeResult = await app.state.plan_changes.confirm(
                str(account["id"]), str(body.preview_id)
            )
        except Exception as exc:
            raise plan_change_error(exc) from exc
        if result.status in {"previewed", "applying"}:
            raise HTTPException(409, "this preview is currently being confirmed")
        response_status = "confirmed"
        if result.status == "requires_action":
            response_status = "action_required" if result.client_secret else "payment_required"
        payload: dict[str, Any] = {
            "status": response_status,
            "timing": result.decision.timing,
            "transition_policy": result.transition_policy,
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
        content_length = request.headers.get("content-length")
        if content_length:
            try:
                declared_length = int(content_length)
            except ValueError:
                return JSONResponse({"error": "invalid Content-Length"}, 400)
            if declared_length < 0:
                return JSONResponse({"error": "invalid Content-Length"}, 400)
            if declared_length > _MAX_STRIPE_WEBHOOK_BYTES:
                return JSONResponse({"error": "Stripe webhook payload is too large"}, 413)
        body = bytearray()
        async for chunk in request.stream():
            if len(body) + len(chunk) > _MAX_STRIPE_WEBHOOK_BYTES:
                return JSONResponse({"error": "Stripe webhook payload is too large"}, 413)
            body.extend(chunk)
        payload = bytes(body)
        try:
            event = gateway.construct_event(payload, stripe_signature)
        except Exception as exc:
            del exc
            return JSONResponse({"error": "invalid Stripe signature"}, 400)
        try:
            processor = app.state.processor
            if await processor.has_committed_event(event.get("id")):
                result = await processor.process(event)
            else:
                prepared = await gateway.prepare_event(event)
                result = await processor.process(prepared)
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
