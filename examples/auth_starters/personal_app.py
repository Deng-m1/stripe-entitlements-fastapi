from __future__ import annotations

from fastapi import FastAPI

from stripe_entitlements.app import create_app
from stripe_entitlements.auth_starters import JwtVerifier, PersonalJwtAuthAdapter
from stripe_entitlements.config import get_settings

from ._environment import jwt_config_from_environment


def create_host_app() -> FastAPI:
    """Create billing APIs whose owner is the verified UUID JWT subject."""

    verifier = JwtVerifier(jwt_config_from_environment())
    return create_app(
        get_settings(),
        auth_adapter=PersonalJwtAuthAdapter(verifier),
    )
