"""Isolated host application for the opt-in real-browser release gate.

This is deliberately not a production identity provider or Job implementation. It
composes the public billing router exactly as a host would, verifies a short-lived
Personal JWT through HTTPS JWKS, and keeps browser identity separate from the signed
workload identity used by the private entitlement facade.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from stripe_entitlements.auth import AuthenticatedIdentity, AuthenticationError
from stripe_entitlements.auth_starters import (
    JwtVerificationConfig,
    JwtVerifier,
    PersonalJwtAuthAdapter,
)
from stripe_entitlements.config import Settings
from stripe_entitlements.integration import install_billing
from stripe_entitlements.internal_api import (
    CREDITS_CHARGE_SCOPE,
    CREDITS_REFUND_SCOPE,
    ENTITLEMENTS_CHECK_SCOPE,
    create_internal_router,
)
from stripe_entitlements.internal_auth import (
    WorkloadAuthenticationError,
    WorkloadAuthorizationError,
    WorkloadPrincipal,
)
from stripe_entitlements.kernel import BillingKernel
from stripe_entitlements.stripe_gateway import StripeGateway


def _required_environment(name: str, *, maximum: int = 8192) -> str:
    value = os.environ.get(name, "")
    if (
        not value
        or value != value.strip()
        or len(value.encode("utf-8")) > maximum
        or any(not character.isprintable() for character in value)
    ):
        raise RuntimeError(f"{name} is required for the browser E2E host")
    return value


@dataclass(frozen=True, slots=True)
class _PortalCreationEvidence:
    customer_id: str
    configuration_id: str
    return_url: str


class _RecordingStripeGateway(StripeGateway):
    """Retain only non-secret Portal binding facts in process memory for E2E proof."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.portal_evidence: dict[str, _PortalCreationEvidence] = {}

    async def create_portal_session(
        self, *, customer_id: str, idempotency_key: str
    ) -> tuple[str, str]:
        session_id, url = await super().create_portal_session(
            customer_id=customer_id,
            idempotency_key=idempotency_key,
        )
        configuration_id = self.portal_configuration_id
        if configuration_id is None:
            raise RuntimeError("the E2E Portal configuration disappeared")
        self.portal_evidence[session_id] = _PortalCreationEvidence(
            customer_id=customer_id,
            configuration_id=configuration_id,
            return_url=self.portal_return_url,
        )
        return session_id, url


class _SignedWorkloadAdapter:
    def __init__(self, verifier: JwtVerifier, issuer: str) -> None:
        self._verifier = verifier
        self._issuer = issuer

    async def authenticate(self, request: Request) -> WorkloadPrincipal:
        try:
            verified = await self._verifier.verify_request(request)
        except (AuthenticationError, HTTPException) as exc:
            raise WorkloadAuthenticationError("signed workload credential rejected") from exc
        return WorkloadPrincipal(
            issuer=self._issuer,
            subject=str(verified.user_id),
            scopes=frozenset(
                {
                    ENTITLEMENTS_CHECK_SCOPE,
                    CREDITS_CHARGE_SCOPE,
                    CREDITS_REFUND_SCOPE,
                }
            ),
        )


class _BoundWorkloadOwnerAuthorizer:
    def __init__(self, workload_subject: str, owner_external_ref: str) -> None:
        self._workload_subject = workload_subject
        self._owner_external_ref = owner_external_ref

    async def authorize(
        self,
        principal: WorkloadPrincipal,
        owner_external_ref: str,
        required_scope: str,
    ) -> None:
        if (
            principal.subject != self._workload_subject
            or owner_external_ref != self._owner_external_ref
            or required_scope not in principal.scopes
        ):
            raise WorkloadAuthorizationError("workload is not bound to this billing owner")


class _StrictRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class _PortalEvidenceRequest(_StrictRequest):
    session_id: str = Field(pattern=r"^bps_[A-Za-z0-9_]+$", max_length=255)


class _ProductJobRequest(_StrictRequest):
    operation_key: str = Field(min_length=1, max_length=200)
    amount: str = Field(min_length=1, max_length=32)
    scenario: Literal["success", "terminal_failure"]


def create_app() -> FastAPI:
    settings = Settings()  # type: ignore[call-arg]
    jwks_path = Path(_required_environment("E2E_PERSONAL_JWKS_FILE"))
    try:
        jwks_document = json.loads(jwks_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise RuntimeError("E2E_PERSONAL_JWKS_FILE is not valid UTF-8 JSON") from exc
    if (
        not isinstance(jwks_document, dict)
        or not isinstance(jwks_document.get("keys"), list)
        or len(jwks_document["keys"]) != 1
    ):
        raise RuntimeError("E2E_PERSONAL_JWKS_FILE must contain exactly one signing key")

    issuer = _required_environment("E2E_JWT_ISSUER")
    personal_audience = _required_environment("E2E_PERSONAL_JWT_AUDIENCE")
    workload_audience = _required_environment("E2E_WORKLOAD_JWT_AUDIENCE")
    workload_subject = _required_environment("E2E_WORKLOAD_SUBJECT")
    workload_token = _required_environment("E2E_WORKLOAD_JWT", maximum=16_384)
    expected_owner = _required_environment("E2E_EXPECTED_OWNER_EXTERNAL_REF")
    success_job_key = _required_environment("E2E_JOB_SUCCESS_KEY", maximum=200)
    failure_job_key = _required_environment("E2E_JOB_FAILURE_KEY", maximum=200)
    personal_verifier = JwtVerifier(
        JwtVerificationConfig(
            issuer=issuer,
            audience=personal_audience,
            jwks_url=f"{issuer}/.well-known/jwks.json",
        )
    )
    personal_auth = PersonalJwtAuthAdapter(personal_verifier)
    workload_verifier = JwtVerifier(
        JwtVerificationConfig(
            issuer=issuer,
            audience=workload_audience,
            jwks_url=f"{issuer}/.well-known/jwks.json",
        )
    )
    gateway = _RecordingStripeGateway(
        settings.stripe_secret_key,
        settings.stripe_webhook_secret,
        settings.product_line,
        api_version=settings.stripe_api_version,
        portal_configuration_id=settings.stripe_portal_configuration_id,
        checkout_success_url=settings.checkout_success_url,
        checkout_cancel_url=settings.checkout_cancel_url,
        portal_return_url=settings.portal_return_url,
    )
    kernel = BillingKernel(settings, gateway=gateway, auth_adapter=personal_auth)
    workload_auth = _SignedWorkloadAdapter(workload_verifier, issuer)
    owner_authorizer = _BoundWorkloadOwnerAuthorizer(workload_subject, expected_owner)

    app = FastAPI(title="Stripe Entitlements Browser E2E Host", version="0.4.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(kernel.origins),
        allow_credentials=True,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "Idempotency-Key"],
    )
    jwks_fetches = 0

    @app.get("/e2e/issuer/.well-known/jwks.json", include_in_schema=False)
    async def local_jwks() -> JSONResponse:
        nonlocal jwks_fetches
        jwks_fetches += 1
        return JSONResponse(jwks_document, headers={"Cache-Control": "no-store"})

    async def current_personal_identity(request: Request) -> AuthenticatedIdentity:
        try:
            identity = await personal_auth.authenticate(request)
        except AuthenticationError as exc:
            raise HTTPException(401, "personal authentication failed") from exc
        if identity.external_ref != expected_owner:
            raise HTTPException(403, "personal identity is outside this E2E run")
        return identity

    async def internal_post(
        path: str,
        payload: dict[str, Any],
        *,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        headers = {"Authorization": f"Bearer {workload_token}"}
        if idempotency_key is not None:
            headers["Idempotency-Key"] = idempotency_key
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="https://internal.e2e.invalid",
            timeout=30,
        ) as client:
            response = await client.post(path, json=payload, headers=headers)
        if response.status_code != 200:
            raise HTTPException(502, "the private entitlement operation failed")
        parsed = response.json()
        if not isinstance(parsed, dict):
            raise HTTPException(502, "the private entitlement response was invalid")
        return parsed

    @app.post("/api/e2e/portal-evidence", include_in_schema=False)
    async def portal_evidence(body: _PortalEvidenceRequest, request: Request) -> dict[str, Any]:
        identity = await current_personal_identity(request)
        account = await kernel.database.existing_account_for_external_ref(identity.external_ref)
        evidence = gateway.portal_evidence.get(body.session_id)
        if account is None or evidence is None:
            raise HTTPException(404, "Portal Session evidence was not found")
        verified = (
            evidence.customer_id == account["stripe_customer_id"]
            and evidence.configuration_id == settings.stripe_portal_configuration_id
            and evidence.return_url == settings.portal_return_url
            and jwks_fetches > 0
        )
        if not verified:
            raise HTTPException(409, "Portal Session evidence is not owner-bound")
        return {
            "verified": True,
            "session_id": body.session_id,
            "personal_jwks_verified": True,
        }

    @app.post("/api/e2e/jobs", include_in_schema=False)
    async def run_product_job(body: _ProductJobRequest, request: Request) -> dict[str, Any]:
        identity = await current_personal_identity(request)
        expected_request = {
            success_job_key: ("80", "success"),
            failure_job_key: ("20", "terminal_failure"),
        }.get(body.operation_key)
        if expected_request != (body.amount, body.scenario):
            raise HTTPException(400, "product Job request is outside this E2E run")
        owner_payload = {"owner_external_ref": identity.external_ref}
        entitlement = await internal_post(
            "/internal/v1/entitlements/check",
            {
                **owner_payload,
                "required_features": ["pdf_to_ppt"],
                "required_limits": {"max_file_mb": 30},
            },
        )
        if entitlement.get("allowed") is not True:
            raise HTTPException(409, "product Job is not entitled")
        charge = await internal_post(
            "/internal/v1/credits/charge",
            {**owner_payload, "amount": body.amount},
            idempotency_key=body.operation_key,
        )
        if body.scenario == "success":
            return {
                "job_status": "succeeded",
                "entitlement": entitlement,
                "charge": charge,
                "refund": None,
            }
        refund = await internal_post(
            "/internal/v1/credits/refund",
            owner_payload,
            idempotency_key=body.operation_key,
        )
        return {
            "job_status": "failed_refunded",
            "entitlement": entitlement,
            "charge": charge,
            "refund": refund,
        }

    internal_router = create_internal_router(
        service_provider=lambda: kernel.services.entitlements,
        auth_adapter=workload_auth,
        owner_authorizer=owner_authorizer,
    )
    install_billing(app, kernel, internal_routers=[internal_router])
    return app
