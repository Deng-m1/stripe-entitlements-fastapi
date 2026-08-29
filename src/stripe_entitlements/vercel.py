from __future__ import annotations

import hmac
import os
from collections.abc import Mapping

from fastapi import FastAPI, HTTPException, Request, Response

from .app import create_app
from .auth import AuthAccountAdapter, RejectAllAuthAdapter
from .auth_starters import JwtVerificationConfig, JwtVerifier, PersonalJwtAuthAdapter
from .config import Settings
from .database import Database
from .kernel import BillingKernel
from .scheduled import run_annual_grant_batch, run_reconciliation_batch
from .stripe_gateway import StripeGateway

_AUTH_MODE = "BILLING_AUTH_MODE"
_JWT_FIELDS = (
    "BILLING_JWT_ISSUER",
    "BILLING_JWT_AUDIENCE",
    "BILLING_JWKS_URL",
)


def _deployment_environment(
    environment: Mapping[str, str] | None,
) -> Mapping[str, str]:
    return os.environ if environment is None else environment


def auth_adapter_from_environment(
    environment: Mapping[str, str] | None = None,
) -> AuthAccountAdapter:
    """Build the personal JWT starter or retain the production reject-all default."""

    values = _deployment_environment(environment)
    mode = values.get(_AUTH_MODE, "reject_all")
    if mode == "reject_all":
        if any(values.get(field) for field in _JWT_FIELDS):
            raise ValueError(
                "BILLING_AUTH_MODE must be personal_jwt when JWT settings are configured"
            )
        return RejectAllAuthAdapter()
    if mode != "personal_jwt":
        raise ValueError("BILLING_AUTH_MODE must be reject_all or personal_jwt")
    missing = [field for field in _JWT_FIELDS if not values.get(field)]
    if missing:
        raise ValueError("personal_jwt authentication requires " + ", ".join(missing))
    algorithms = tuple(
        item.strip()
        for item in values.get("BILLING_JWT_ALGORITHMS", "RS256").split(",")
        if item.strip()
    )
    verifier = JwtVerifier(
        JwtVerificationConfig(
            issuer=values["BILLING_JWT_ISSUER"],
            audience=values["BILLING_JWT_AUDIENCE"],
            jwks_url=values["BILLING_JWKS_URL"],
            algorithms=algorithms,
        )
    )
    return PersonalJwtAuthAdapter(verifier)


def _cron_secret(environment: Mapping[str, str]) -> str | None:
    value = environment.get("CRON_SECRET")
    if value is None:
        return None
    if (
        value != value.strip()
        or not value.isascii()
        or len(value) < 16
        or len(value) > 512
        or any(not character.isprintable() for character in value)
    ):
        raise ValueError("CRON_SECRET must be 16 to 512 visible ASCII characters")
    return value


def _authorize_cron(request: Request, secret: str | None) -> None:
    if secret is None:
        raise HTTPException(503, "scheduled workers are not configured")
    supplied = request.headers.get("Authorization", "")
    if not hmac.compare_digest(
        supplied.encode("utf-8"),
        f"Bearer {secret}".encode(),
    ):
        raise HTTPException(401, "invalid scheduler authorization")


def create_vercel_app(
    settings: Settings | None = None,
    *,
    database: Database | None = None,
    gateway: StripeGateway | None = None,
    auth_adapter: AuthAccountAdapter | None = None,
    environment: Mapping[str, str] | None = None,
) -> FastAPI:
    """Create the Vercel Services ASGI app with secured, bounded Cron routes."""

    values = _deployment_environment(environment)
    cron_secret = _cron_secret(values)
    app = create_app(
        settings,
        database=database,
        gateway=gateway,
        auth_adapter=(
            auth_adapter if auth_adapter is not None else auth_adapter_from_environment(values)
        ),
    )
    kernel = app.state.stripe_entitlements
    if not isinstance(kernel, BillingKernel):
        raise RuntimeError("billing kernel was not installed")

    @app.get("/api/cron/annual-grants", include_in_schema=False)
    async def annual_grants(request: Request, response: Response) -> dict[str, bool | int]:
        _authorize_cron(request, cron_secret)
        result = await run_annual_grant_batch(kernel)
        if not result.ok:
            response.status_code = 503
        return result.public_summary()

    @app.get("/api/cron/reconcile", include_in_schema=False)
    async def reconcile(request: Request, response: Response) -> dict[str, bool | int]:
        _authorize_cron(request, cron_secret)
        result = await run_reconciliation_batch(kernel)
        if not result.ok:
            response.status_code = 503
        return result.public_summary()

    return app


__all__ = ["auth_adapter_from_environment", "create_vercel_app"]
