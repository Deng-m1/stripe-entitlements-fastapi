from __future__ import annotations

import hmac
from dataclasses import dataclass
from typing import Protocol

from fastapi import Request


class AuthenticationError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class AuthenticatedIdentity:
    """Stable identity returned by a host application's verified auth integration."""

    external_ref: str
    email: str | None = None


class AuthAccountAdapter(Protocol):
    async def authenticate(self, request: Request) -> AuthenticatedIdentity: ...


class RejectAllAuthAdapter:
    """Safe default: billing APIs stay closed until the host injects authentication."""

    async def authenticate(self, request: Request) -> AuthenticatedIdentity:
        del request
        raise AuthenticationError("no authentication adapter is configured")


class DemoBearerAuthAdapter:
    """Explicit test-mode local adapter; never enable it in production."""

    def __init__(self, token: str, subject: str, email: str | None = None) -> None:
        if not token or not subject:
            raise ValueError("demo token and subject are required")
        self._token = token
        self._identity = AuthenticatedIdentity(subject, email)

    async def authenticate(self, request: Request) -> AuthenticatedIdentity:
        scheme, _, credential = request.headers.get("Authorization", "").partition(" ")
        if scheme.lower() != "bearer" or not hmac.compare_digest(credential, self._token):
            raise AuthenticationError("invalid bearer token")
        return self._identity
