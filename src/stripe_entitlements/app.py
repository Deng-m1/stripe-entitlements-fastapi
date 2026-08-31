import logging
from datetime import UTC, datetime
from typing import Annotated, Any, Literal
from urllib.parse import parse_qsl, urlsplit
from uuid import UUID

from fastapi import APIRouter, Depends, FastAPI, Header, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from .auth import (
    AuthAccountAdapter,
    AuthenticatedIdentity,
    AuthenticationError,
)
from .checkout import (
    CheckoutActiveSubscriptionError,
    CheckoutBusyError,
    CheckoutCreationRejected,
    CheckoutReplayUnsafeError,
)
from .config import Settings
from .credit_amount import CREDIT_SCALE, credit_decimal
from .credit_packs import CreditPackBusyError, CreditPackConflictError
from .database import Database
from .integration import _install_standalone_billing, normalize_billing_prefix
from .kernel import BillingKernel
from .owner_reference import InvalidOwnerReferenceError, validate_owner_external_ref
from .plan_changes import (
    PlanChangeBusyError,
    PlanChangeConflictError,
    PlanChangeResult,
    PlanChangeUnavailableError,
)
from .stripe_gateway import PortalConfigurationUnavailableError, StripeGateway
from .subscription_state import (
    spendable_subscription_atoms,
    subscription_credits_are_spendable,
)


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


class CreditPackCheckoutRequest(_StrictRequest):
    pack_key: Annotated[str, Field(min_length=1, max_length=64)]
    success_url: Annotated[str, Field(min_length=1, max_length=2048)]
    cancel_url: Annotated[str, Field(min_length=1, max_length=2048)]


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


def create_billing_router(
    kernel: BillingKernel,
    *,
    prefix: str = "",
) -> APIRouter:
    """Create the native FastAPI router for one validated billing kernel."""

    settings = kernel.settings
    database = kernel.database
    gateway = kernel.gateway
    auth_adapter = kernel.auth_adapter
    catalog = kernel.catalog
    gateway_test_mode = kernel.stripe_test_mode
    router = APIRouter(prefix=normalize_billing_prefix(prefix))

    async def current_identity(request: Request) -> AuthenticatedIdentity:
        try:
            identity = await auth_adapter.authenticate(request)
        except AuthenticationError as exc:
            raise HTTPException(401, "authentication failed") from exc
        try:
            validate_owner_external_ref(identity.external_ref)
        except InvalidOwnerReferenceError:
            raise HTTPException(
                401, "authenticated identity has an invalid stable subject"
            ) from None
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
                "value": str(plan.monthly_credits),
                "value_atoms": str(plan.monthly_credits.atoms),
                "scale": CREDIT_SCALE,
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
        async with database.require_pool().acquire() as conn:
            pack_as_of = (
                database_now
                if isinstance(database_now, datetime)
                else await conn.fetchval("select clock_timestamp()")
            )
            pack_rows = await conn.fetch(
                """select l.id,l.remaining_credits,l.expires_at,o.pack_key,
                          o.stripe_checkout_session_id
                     from credit_funding_lots l
                     join credit_pack_orders o on o.id=l.order_id
                    where l.account_id=$1 and l.status='active'
                      and l.remaining_credits > 0 and l.expires_at > $2
                    order by l.expires_at,l.id""",
                account["id"],
                pack_as_of,
            )
        purchased_atoms = sum(int(row["remaining_credits"]) for row in pack_rows)
        subscription_atoms = spendable_subscription_atoms(account, as_of=database_now)
        balance_atoms = subscription_atoms + purchased_atoms
        grant_atoms = plan.monthly_credits.atoms if plan else 0
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
                "balance": credit_decimal(balance_atoms),
                "balance_atoms": str(balance_atoms),
                "subscription_balance": credit_decimal(subscription_atoms),
                "subscription_balance_atoms": str(subscription_atoms),
                "purchased_balance": credit_decimal(purchased_atoms),
                "purchased_balance_atoms": str(purchased_atoms),
                "grant_amount": credit_decimal(grant_atoms),
                "grant_amount_atoms": str(grant_atoms),
                "scale": CREDIT_SCALE,
                "next_grant_at": (
                    account["credit_expires_at"].isoformat()
                    if account["credit_expires_at"]
                    else None
                ),
                "credit_packs": [
                    {
                        "lot_id": str(row["id"]),
                        "pack_key": row["pack_key"],
                        "checkout_session_id": row["stripe_checkout_session_id"],
                        "remaining": credit_decimal(int(row["remaining_credits"])),
                        "remaining_atoms": str(row["remaining_credits"]),
                        "expires_at": row["expires_at"].isoformat(),
                    }
                    for row in pack_rows
                ],
            },
            "entitlements": entitlement_rows(str(account["plan_key"])),
            "entitlements_enforceable": bool(
                plan is not None and subscription_credits_are_spendable(account, as_of=database_now)
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

    def require_stripe_mode(requirement: str | None) -> None:
        if requirement not in {None, "test"}:
            raise HTTPException(
                400,
                "X-Stripe-Mode-Requirement must be test when supplied",
            )
        if requirement == "test" and not gateway_test_mode:
            raise HTTPException(409, "billing backend is not in the required Stripe test mode")

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

    def require_credit_pack_success_url(value: str, *, pack_key: str) -> None:
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
        if dict(query_pairs) not in ({}, {"expected_credit_pack": pack_key}):
            raise HTTPException(400, "success_url query does not match the credit pack")

    def plan_change_error(exc: Exception) -> HTTPException:
        if isinstance(exc, (PlanChangeBusyError, CheckoutBusyError)):
            return HTTPException(409, str(exc))
        if isinstance(exc, (PlanChangeConflictError, ValueError)):
            return HTTPException(400, str(exc))
        if isinstance(exc, PlanChangeUnavailableError):
            return HTTPException(409, str(exc))
        return HTTPException(502, "Stripe plan change failed; retry the same request")

    @router.get("/health")
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

    @router.get("/api/catalog")
    @router.get("/billing/catalog", include_in_schema=False)
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
            "credit_packs": [
                {
                    "key": pack.key,
                    "name": pack.name,
                    "description": pack.description,
                    "display_order": pack.rank,
                    "credits": str(pack.credits),
                    "credits_atoms": str(pack.credits.atoms),
                    "credit_scale": CREDIT_SCALE,
                    "price": {
                        "currency": pack.currency,
                        "unit_amount": pack.price_usd * 100,
                    },
                    "expires_days": pack.expires_days,
                }
                for pack in catalog.ordered_credit_packs()
            ],
        }

    @router.get("/api/account")
    @router.get("/billing/account", include_in_schema=False)
    async def get_billing_account(account: Account) -> dict[str, Any]:
        return await account_response(account)

    @router.post("/api/checkout")
    @router.post("/billing/checkout", include_in_schema=False)
    async def create_checkout(
        body: CheckoutRequest,
        identity: Identity,
        idempotency_key: str = Header(alias="Idempotency-Key"),
        stripe_mode_requirement: str | None = Header(
            default=None, alias="X-Stripe-Mode-Requirement"
        ),
    ) -> dict[str, str]:
        require_stripe_mode(stripe_mode_requirement)
        request_key = require_idempotency(idempotency_key)
        account = await database.existing_account_for_external_ref(identity.external_ref)
        if account is not None:
            try:
                recovered = await kernel.require_services().checkout.recover_frozen(
                    gateway,
                    account_id=str(account["id"]),
                    plan_key=body.plan_key,
                    interval=body.interval,
                    request_key=request_key,
                )
            except CheckoutReplayUnsafeError as exc:
                raise HTTPException(409, str(exc)) from exc
            except ValueError as exc:
                raise HTTPException(400, str(exc)) from exc
            except Exception as exc:
                raise HTTPException(
                    502, "Stripe Checkout is temporarily unavailable; retry the same request"
                ) from exc
            if recovered is not None:
                return {"url": recovered[1]}
        require_checkout_success_url(
            body.success_url, plan_key=body.plan_key, interval=body.interval
        )
        require_configured_url(body.cancel_url, settings.checkout_cancel_url, "cancel_url")
        try:
            plan = catalog.require(body.plan_key)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        if account is None:
            account = await database.account_for_external_ref(identity.external_ref)
        try:
            session_id, url = await kernel.require_services().checkout.create(
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
            CheckoutReplayUnsafeError,
        ) as exc:
            raise HTTPException(409, str(exc)) from exc
        except Exception as exc:
            raise HTTPException(
                502, "Stripe Checkout is temporarily unavailable; retry the same request"
            ) from exc
        del session_id
        return {"url": url}

    @router.post("/api/credit-packs/checkout")
    async def create_credit_pack_checkout(
        body: CreditPackCheckoutRequest,
        identity: Identity,
        idempotency_key: str = Header(alias="Idempotency-Key"),
        stripe_mode_requirement: str | None = Header(
            default=None, alias="X-Stripe-Mode-Requirement"
        ),
    ) -> dict[str, str]:
        require_stripe_mode(stripe_mode_requirement)
        request_key = require_idempotency(idempotency_key)
        account = await database.existing_account_for_external_ref(identity.external_ref)
        if account is not None:
            try:
                recovered = await kernel.require_services().credit_packs.recover_frozen(
                    gateway,
                    account_id=str(account["id"]),
                    pack_key=body.pack_key,
                    request_key=request_key,
                )
            except CreditPackConflictError as exc:
                raise HTTPException(409, str(exc)) from exc
            except ValueError as exc:
                raise HTTPException(400, str(exc)) from exc
            except Exception as exc:
                raise HTTPException(
                    502,
                    "Stripe credit-pack Checkout is temporarily unavailable; "
                    "retry the same request",
                ) from exc
            if recovered is not None:
                return {"session_id": recovered[0], "url": recovered[1]}
        try:
            catalog.require_credit_pack(body.pack_key)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        require_credit_pack_success_url(body.success_url, pack_key=body.pack_key)
        require_configured_url(body.cancel_url, settings.checkout_cancel_url, "cancel_url")
        if account is None:
            account = await database.account_for_external_ref(identity.external_ref)
        try:
            session_id, url = await kernel.require_services().credit_packs.create(
                gateway,
                account_id=str(account["id"]),
                customer_id=account["stripe_customer_id"],
                customer_email=identity.email,
                pack_key=body.pack_key,
                request_key=request_key,
            )
        except (
            CreditPackBusyError,
            CreditPackConflictError,
            CheckoutCreationRejected,
        ) as exc:
            raise HTTPException(409, str(exc)) from exc
        except Exception as exc:
            raise HTTPException(
                502,
                "Stripe credit-pack Checkout is temporarily unavailable; retry the same request",
            ) from exc
        return {"session_id": session_id, "url": url}

    @router.post("/api/billing/portal")
    @router.post("/billing/portal", include_in_schema=False)
    async def create_portal(
        body: PortalRequest,
        identity: Identity,
        idempotency_key: str = Header(alias="Idempotency-Key"),
        stripe_mode_requirement: str | None = Header(
            default=None, alias="X-Stripe-Mode-Requirement"
        ),
    ) -> dict[str, str]:
        require_stripe_mode(stripe_mode_requirement)
        require_configured_url(body.return_url, settings.portal_return_url, "return_url")
        request_key = require_idempotency(idempotency_key)
        account = await database.existing_account_for_external_ref(identity.external_ref)
        if account is None or not account["stripe_customer_id"]:
            raise HTTPException(409, "account has no Stripe customer")
        try:
            session_id, url = await gateway.create_portal_session(
                customer_id=str(account["stripe_customer_id"]),
                idempotency_key=f"portal:{account['id']}:{request_key}",
            )
        except PortalConfigurationUnavailableError as exc:
            raise HTTPException(503, "Stripe Portal configuration is missing or invalid") from exc
        except Exception as exc:
            raise HTTPException(502, "Stripe Portal is temporarily unavailable") from exc
        return {"session_id": session_id, "url": url}

    @router.post("/api/billing/change/preview")
    @router.post("/billing/plan-change/preview", include_in_schema=False)
    async def preview_plan_change(
        body: PlanChangePreviewRequest,
        identity: Identity,
        idempotency_key: str = Header(alias="Idempotency-Key"),
        stripe_mode_requirement: str | None = Header(
            default=None, alias="X-Stripe-Mode-Requirement"
        ),
    ) -> dict[str, Any]:
        require_stripe_mode(stripe_mode_requirement)
        request_key = require_idempotency(idempotency_key)
        try:
            catalog.require(body.plan_key)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        account = await database.existing_account_for_external_ref(identity.external_ref)
        if account is None:
            raise HTTPException(409, "an active paid subscription is required")
        try:
            result: PlanChangeResult = await kernel.require_services().plan_changes.preview_remote(
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
                credit_decimal(result.entitlement_credit_delta)
                if result.decision.timing == "immediate"
                and result.transition_policy == "prorated_delta"
                and result.entitlement_credit_delta is not None
                else None
            ),
            "entitlement_credit_delta_atoms": (
                str(result.entitlement_credit_delta)
                if result.decision.timing == "immediate"
                and result.transition_policy == "prorated_delta"
                and result.entitlement_credit_delta is not None
                else None
            ),
            "credit_scale": CREDIT_SCALE,
            "next_invoice_amount": (
                target.month_usd if result.decision.target_interval == "month" else target.year_usd
            )
            * 100,
        }

    @router.post("/api/billing/change/confirm")
    @router.post("/billing/plan-change/confirm", include_in_schema=False)
    async def confirm_plan_change(
        body: PlanChangeConfirmRequest,
        identity: Identity,
        stripe_mode_requirement: str | None = Header(
            default=None, alias="X-Stripe-Mode-Requirement"
        ),
    ) -> dict[str, Any]:
        require_stripe_mode(stripe_mode_requirement)
        account = await database.existing_account_for_external_ref(identity.external_ref)
        if account is None:
            raise HTTPException(409, "plan-change preview not found")
        try:
            result: PlanChangeResult = await kernel.require_services().plan_changes.confirm(
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

    @router.post("/webhooks/stripe")
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
            processor = kernel.require_services().processor
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

    return router


def create_app(
    settings: Settings | None = None,
    *,
    database: Database | None = None,
    gateway: StripeGateway | None = None,
    auth_adapter: AuthAccountAdapter | None = None,
) -> FastAPI:
    """Create the standalone reference app using the same composable installer."""

    kernel = BillingKernel(
        settings,
        database=database,
        gateway=gateway,
        auth_adapter=auth_adapter,
    )
    app = FastAPI(title="Stripe Entitlements Reference", version="0.4.0")
    _install_standalone_billing(app, kernel)
    return app
