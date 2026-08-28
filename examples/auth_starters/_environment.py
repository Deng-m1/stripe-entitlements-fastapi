from __future__ import annotations

import os

from stripe_entitlements.auth_starters import JwtVerificationConfig


def _required(name: str) -> str:
    value = os.environ.get(name)
    if value is None:
        raise RuntimeError(f"{name} is required")
    return value


def jwt_config_from_environment() -> JwtVerificationConfig:
    raw_algorithms = os.environ.get("AUTH_JWT_ALGORITHMS", "RS256")
    algorithms = tuple(part.strip() for part in raw_algorithms.split(",") if part.strip())
    return JwtVerificationConfig(
        issuer=_required("AUTH_JWT_ISSUER"),
        audience=_required("AUTH_JWT_AUDIENCE"),
        jwks_url=_required("AUTH_JWKS_URL"),
        algorithms=algorithms,
    )
