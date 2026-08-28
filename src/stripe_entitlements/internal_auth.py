from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Protocol

from fastapi import Request

_SCOPE = re.compile(r"^[a-z][a-z0-9:_-]{0,127}$")


class WorkloadAuthenticationError(RuntimeError):
    """An expected, sanitized workload credential rejection."""


class WorkloadAuthorizationError(RuntimeError):
    """An expected, sanitized workload-to-owner authorization rejection."""


@dataclass(frozen=True, slots=True)
class WorkloadPrincipal:
    """Verified service identity supplied by the host's workload authenticator."""

    issuer: str
    subject: str
    scopes: frozenset[str]

    def __post_init__(self) -> None:
        for field, value in (("issuer", self.issuer), ("subject", self.subject)):
            if (
                type(value) is not str
                or not value
                or value != value.strip()
                or len(value.encode("utf-8")) > 512
                or any(not character.isprintable() for character in value)
            ):
                raise ValueError(f"workload principal {field} is invalid")
        if type(self.scopes) is not frozenset:
            raise ValueError("workload principal scopes must be a frozenset")
        if len(self.scopes) > 64 or any(
            type(scope) is not str or _SCOPE.fullmatch(scope) is None for scope in self.scopes
        ):
            raise ValueError("workload principal scopes are invalid")


class WorkloadIdentityAdapter(Protocol):
    """Verify a workload credential, including issuer, expiry and replay policy.

    The adapter is the trust boundary. Implementations must authenticate the complete
    credential and validate algorithm, issuer, audience, expiry, not-before, revocation
    and replay policy before returning a principal; merely decoding a token is
    insufficient.
    """

    async def authenticate(self, request: Request) -> WorkloadPrincipal: ...


class WorkloadOwnerAuthorizer(Protocol):
    """Bind a verified workload to the billable owner selected by a request.

    Implementations normally consult host-owned service/tenant grants. A route scope
    alone is intentionally insufficient authority to select every billing owner.
    """

    async def authorize(
        self,
        principal: WorkloadPrincipal,
        owner_external_ref: str,
        required_scope: str,
    ) -> None: ...


class RejectAllWorkloadIdentityAdapter:
    """Safe default for internal APIs until the host injects workload identity."""

    async def authenticate(self, request: Request) -> WorkloadPrincipal:
        del request
        raise WorkloadAuthenticationError("no workload identity adapter is configured")


class RejectAllWorkloadOwnerAuthorizer:
    """Safe default until the host explicitly binds workloads to billing owners."""

    async def authorize(
        self,
        principal: WorkloadPrincipal,
        owner_external_ref: str,
        required_scope: str,
    ) -> None:
        del principal, owner_external_ref, required_scope
        raise WorkloadAuthorizationError("no workload owner authorizer is configured")
