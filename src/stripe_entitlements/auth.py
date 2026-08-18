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
        for field, value, maximum in (
            ("demo token", token, 512),
            ("demo subject", subject, 512),
        ):
            if (
                not isinstance(value, str)
                or not value
                or value != value.strip()
                or len(value.encode("utf-8")) > maximum
                or any(not character.isprintable() for character in value)
                or (field == "demo token" and not value.isascii())
            ):
                raise ValueError(f"{field} must be a bounded visible string")
        if email is not None and (
            not isinstance(email, str)
            or not email
            or email != email.strip()
            or len(email.encode("utf-8")) > 320
            or any(not character.isprintable() for character in email)
        ):
            raise ValueError("demo email must be a bounded visible string")
        self._token = token.encode("utf-8")
        self._identity = AuthenticatedIdentity(subject, email)

    async def authenticate(self, request: Request) -> AuthenticatedIdentity:
        scheme, _, credential = request.headers.get("Authorization", "").partition(" ")
        if scheme.lower() != "bearer" or not hmac.compare_digest(
            credential.encode("utf-8"), self._token
        ):
            raise AuthenticationError("invalid bearer token")
        return self._identity
