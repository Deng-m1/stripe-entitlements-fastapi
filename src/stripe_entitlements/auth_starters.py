from __future__ import annotations

import asyncio
import threading
import time
from collections import OrderedDict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from enum import StrEnum
from types import MappingProxyType
from typing import Any, Protocol
from urllib.parse import urlsplit
from uuid import UUID

import jwt
from fastapi import HTTPException, Request
from jwt import PyJWKClient
from jwt.exceptions import PyJWKClientConnectionError, PyJWKClientError, PyJWTError
from starlette._utils import get_route_path

from .auth import AuthenticatedIdentity, AuthenticationError
from .integration import normalize_billing_prefix

_ASYMMETRIC_JWT_ALGORITHMS = frozenset(
    {
        "RS256",
        "RS384",
        "RS512",
        "PS256",
        "PS384",
        "PS512",
        "ES256",
        "ES384",
        "ES512",
        "EdDSA",
    }
)
_MAX_BEARER_BYTES = 16_384
_MAX_CLAIM_BYTES = 512
_MAX_OWNER_REFERENCE_BYTES = 512
_USER_OWNER_PREFIX = "v1:user:"
_TENANT_OWNER_PREFIX = "v1:tenant:"


def _bounded_visible(value: object, *, field: str, maximum: int) -> str:
    if (
        type(value) is not str
        or not value
        or value != value.strip()
        or len(value.encode("utf-8")) > maximum
        or any(not character.isprintable() for character in value)
    ):
        raise ValueError(f"{field} must be a bounded visible string")
    return value


def _bounded_integer(value: object, *, field: str, lower: int, upper: int) -> int:
    if type(value) is not int or not lower <= value <= upper:
        raise ValueError(f"{field} must be an integer from {lower} to {upper}")
    return value


def _stable_identity_claim(
    value: object, *, field: str, maximum: int = _MAX_CLAIM_BYTES
) -> UUID | str:
    try:
        text = _bounded_visible(value, field=field, maximum=maximum)
    except ValueError as exc:
        raise AuthenticationError("invalid bearer token") from exc
    try:
        parsed = UUID(text)
    except ValueError:
        return text
    # Preserve the historical UUID object for an already-canonical identifier,
    # but otherwise keep the provider identifier opaque and byte-for-byte stable.
    # UUID-looking non-canonical values therefore have the same semantics as every
    # other opaque value instead of being rejected only because of their shape.
    return parsed if parsed.int != 0 and str(parsed) == text else text


def _subject_claim(value: object) -> UUID | str:
    return _stable_identity_claim(value, field="sub")


def _owner_reference(prefix: str, identifier: UUID | str) -> str:
    try:
        return _bounded_visible(
            f"{prefix}{identifier}",
            field="owner reference",
            maximum=_MAX_OWNER_REFERENCE_BYTES,
        )
    except ValueError as exc:
        raise AuthenticationError("invalid bearer token") from exc


def _verified_email(claims: Mapping[str, Any]) -> str | None:
    if claims.get("email_verified") is not True:
        return None
    value = claims.get("email")
    try:
        email = _bounded_visible(value, field="email", maximum=320)
    except ValueError as exc:
        raise AuthenticationError("invalid bearer token") from exc
    if email.count("@") != 1 or any(character.isspace() for character in email):
        raise AuthenticationError("invalid bearer token")
    return email


@dataclass(frozen=True, slots=True)
class JwtVerificationConfig:
    """Strict production verification contract for one JWT issuer and audience."""

    issuer: str
    audience: str
    jwks_url: str
    algorithms: tuple[str, ...] = ("RS256",)
    leeway_seconds: int = 0
    jwks_cache_seconds: int = 300
    jwks_timeout_seconds: int = 5
    jwks_refresh_cooldown_seconds: int = 5
    jwks_max_concurrent_lookups: int = 8
    jwks_unknown_kid_cache_size: int = 1024
    jwks_unknown_kid_ttl_seconds: int = 5

    def __post_init__(self) -> None:
        issuer = _bounded_visible(self.issuer, field="issuer", maximum=2048)
        audience = _bounded_visible(self.audience, field="audience", maximum=512)
        jwks_url = _bounded_visible(self.jwks_url, field="JWKS URL", maximum=2048)
        for field, value in (("issuer", issuer), ("JWKS URL", jwks_url)):
            parsed = urlsplit(value)
            if (
                parsed.scheme != "https"
                or not parsed.netloc
                or parsed.username is not None
                or parsed.password is not None
                or parsed.fragment
            ):
                raise ValueError(f"{field} must be an HTTPS URL without credentials or fragment")
        if (
            type(self.algorithms) is not tuple
            or not self.algorithms
            or len(set(self.algorithms)) != len(self.algorithms)
            or any(algorithm not in _ASYMMETRIC_JWT_ALGORITHMS for algorithm in self.algorithms)
        ):
            raise ValueError("algorithms must be a non-empty unique asymmetric JWT allowlist")
        _bounded_integer(self.leeway_seconds, field="leeway_seconds", lower=0, upper=300)
        _bounded_integer(
            self.jwks_cache_seconds,
            field="jwks_cache_seconds",
            lower=1,
            upper=86_400,
        )
        _bounded_integer(
            self.jwks_timeout_seconds,
            field="jwks_timeout_seconds",
            lower=1,
            upper=30,
        )
        _bounded_integer(
            self.jwks_refresh_cooldown_seconds,
            field="jwks_refresh_cooldown_seconds",
            lower=1,
            upper=60,
        )
        _bounded_integer(
            self.jwks_max_concurrent_lookups,
            field="jwks_max_concurrent_lookups",
            lower=1,
            upper=64,
        )
        _bounded_integer(
            self.jwks_unknown_kid_cache_size,
            field="jwks_unknown_kid_cache_size",
            lower=1,
            upper=4096,
        )
        _bounded_integer(
            self.jwks_unknown_kid_ttl_seconds,
            field="jwks_unknown_kid_ttl_seconds",
            lower=1,
            upper=300,
        )
        if self.jwks_cache_seconds < self.jwks_refresh_cooldown_seconds:
            raise ValueError(
                "jwks_cache_seconds must be greater than or equal to jwks_refresh_cooldown_seconds"
            )
        object.__setattr__(self, "issuer", issuer)
        object.__setattr__(self, "audience", audience)
        object.__setattr__(self, "jwks_url", jwks_url)


@dataclass(frozen=True, slots=True)
class VerifiedJwt:
    user_id: UUID | str
    email: str | None
    claims: Mapping[str, Any]


class SigningKeyProvider(Protocol):
    def signing_key(self, token: str) -> Any: ...


@dataclass(frozen=True, slots=True)
class _SigningKeySnapshot:
    signing_keys: tuple[Any, ...]
    expires_at: float


class PyJwksSigningKeyProvider:
    """Thread-safe JWKS resolver with one cross-``kid`` refresh budget.

    PyJWT refreshes its JWKS set once for every unknown ``kid``. An attacker can
    therefore turn distinct random headers into O(N) identity-provider requests.
    This wrapper owns the signing-key snapshot and permits at most one network
    refresh per global cooldown, independent of the requested ``kid``. Requests
    for the same ``kid`` share an in-flight cold/TTL refresh; unrelated misses fail
    fast instead of consuming the whole verification worker pool.
    """

    def __init__(self, config: JwtVerificationConfig) -> None:
        self._client = PyJWKClient(
            config.jwks_url,
            cache_keys=False,
            cache_jwk_set=True,
            lifespan=config.jwks_cache_seconds,
            timeout=config.jwks_timeout_seconds,
        )
        self._lock = threading.Lock()
        self._condition = threading.Condition(self._lock)
        self._cache_seconds = config.jwks_cache_seconds
        self._refresh_cooldown_seconds = config.jwks_refresh_cooldown_seconds
        self._refresh_wait_seconds = float(config.jwks_timeout_seconds + 1)
        self._unknown_kid_cache_size = config.jwks_unknown_kid_cache_size
        self._unknown_kid_ttl_seconds = config.jwks_unknown_kid_ttl_seconds
        self._snapshot: _SigningKeySnapshot | None = None
        self._next_refresh_at = 0.0
        self._refresh_inflight = False
        self._refresh_key_id: str | None = None
        self._last_refresh_failed = False
        self._unknown_kids: OrderedDict[str, float] = OrderedDict()
        self._monotonic = time.monotonic

    @staticmethod
    def _key_id(token: str) -> str:
        try:
            key_id = jwt.get_unverified_header(token).get("kid")
            return _bounded_visible(key_id, field="JWT kid", maximum=512)
        except (PyJWTError, ValueError) as exc:
            raise PyJWKClientError("JWT header has no valid kid") from exc

    @staticmethod
    def _missing_key(key_id: str) -> PyJWKClientError:
        return PyJWKClientError(f'Unable to find a signing key that matches: "{key_id}"')

    @staticmethod
    def _match(signing_keys: Sequence[Any], key_id: str) -> Any | None:
        return next((key for key in signing_keys if key.key_id == key_id), None)

    def _remember_unknown_locked(self, key_id: str, now: float) -> None:
        self._unknown_kids.pop(key_id, None)
        # Never let an observation from the old snapshot suppress the first
        # rotation refresh allowed by the global cooldown.
        self._unknown_kids[key_id] = min(
            now + self._unknown_kid_ttl_seconds,
            self._next_refresh_at,
        )
        while len(self._unknown_kids) > self._unknown_kid_cache_size:
            self._unknown_kids.popitem(last=False)

    def _unknown_is_cached_locked(self, key_id: str, now: float) -> bool:
        expires_at = self._unknown_kids.get(key_id)
        if expires_at is None:
            return False
        if now >= expires_at:
            del self._unknown_kids[key_id]
            return False
        self._unknown_kids.move_to_end(key_id)
        return True

    def _refresh(self, reserved_until: float) -> _SigningKeySnapshot:
        """Fetch without the state lock, then atomically publish one snapshot."""

        try:
            signing_keys = tuple(self._client.get_signing_keys(refresh=True))
        except BaseException as exc:
            completed_at = self._monotonic()
            with self._condition:
                self._refresh_inflight = False
                self._refresh_key_id = None
                self._next_refresh_at = max(
                    reserved_until,
                    completed_at + self._refresh_cooldown_seconds,
                )
                self._last_refresh_failed = True
                self._condition.notify_all()
            if isinstance(exc, PyJWKClientConnectionError):
                raise
            if isinstance(exc, Exception):
                raise PyJWKClientConnectionError(
                    "JWKS endpoint did not return a usable signing-key set"
                ) from exc
            raise
        completed_at = self._monotonic()
        snapshot = _SigningKeySnapshot(
            signing_keys=signing_keys,
            expires_at=completed_at + self._cache_seconds,
        )
        with self._condition:
            self._snapshot = snapshot
            self._refresh_inflight = False
            self._refresh_key_id = None
            self._next_refresh_at = max(
                reserved_until,
                completed_at + self._refresh_cooldown_seconds,
            )
            self._last_refresh_failed = False
            # A newly published key set supersedes every negative observation made
            # against the previous snapshot.
            self._unknown_kids.clear()
            self._condition.notify_all()
        return snapshot

    def signing_key(self, token: str) -> Any:
        key_id = self._key_id(token)
        while True:
            now = self._monotonic()
            snapshot = self._snapshot
            # Snapshots are immutable and published atomically. A slow refresh must not
            # make a known key wait behind an attacker-triggered network request.
            if snapshot is not None and now < snapshot.expires_at:
                signing_key = self._match(snapshot.signing_keys, key_id)
                if signing_key is not None:
                    return signing_key

            with self._condition:
                now = self._monotonic()
                snapshot = self._snapshot
                if snapshot is not None and now < snapshot.expires_at:
                    signing_key = self._match(snapshot.signing_keys, key_id)
                    if signing_key is not None:
                        return signing_key

                if self._unknown_is_cached_locked(key_id, now):
                    raise self._missing_key(key_id)

                if self._refresh_inflight:
                    if self._refresh_key_id != key_id:
                        raise PyJWKClientConnectionError("JWKS refresh is in progress")
                    completed = self._condition.wait_for(
                        lambda: not self._refresh_inflight,
                        timeout=self._refresh_wait_seconds,
                    )
                    if not completed:
                        raise PyJWKClientConnectionError("JWKS refresh timed out")
                    continue

                if now < self._next_refresh_at:
                    stale_key = (
                        self._match(snapshot.signing_keys, key_id) if snapshot is not None else None
                    )
                    if self._last_refresh_failed or stale_key is not None:
                        raise PyJWKClientConnectionError("JWKS refresh is cooling down")
                    self._remember_unknown_locked(key_id, now)
                    raise self._missing_key(key_id)

                reserved_until = now + self._refresh_cooldown_seconds
                self._refresh_inflight = True
                self._refresh_key_id = key_id
                self._next_refresh_at = reserved_until
                self._last_refresh_failed = False

            snapshot = self._refresh(reserved_until)
            signing_key = self._match(snapshot.signing_keys, key_id)
            if signing_key is not None:
                return signing_key

            with self._condition:
                # Another successful refresh cannot race this one: refresh admission is
                # global, but keep the cache observation tied to the published snapshot.
                current = self._snapshot
                if current is not snapshot:
                    assert current is not None
                    signing_key = self._match(current.signing_keys, key_id)
                    if signing_key is not None:
                        return signing_key
                self._remember_unknown_locked(key_id, self._monotonic())
            raise self._missing_key(key_id)


class IdentityProviderUnavailable(HTTPException):
    """Sanitized 503 for a known JWKS transport or document failure."""

    def __init__(self) -> None:
        super().__init__(
            status_code=503,
            detail="identity provider temporarily unavailable",
            headers={"Retry-After": "5"},
        )


class JwtVerifier:
    """Verify a Bearer JWT against JWKS without blocking the event loop."""

    def __init__(
        self,
        config: JwtVerificationConfig,
        *,
        signing_keys: SigningKeyProvider | None = None,
    ) -> None:
        self._config = config
        self._signing_keys = signing_keys or PyJwksSigningKeyProvider(config)
        self._lookup_slots = asyncio.BoundedSemaphore(config.jwks_max_concurrent_lookups)

    async def verify_request(self, request: Request) -> VerifiedJwt:
        authorization = request.headers.get("Authorization", "")
        scheme, separator, token = authorization.partition(" ")
        if (
            scheme.lower() != "bearer"
            or separator != " "
            or not token
            or token != token.strip()
            or any(character.isspace() for character in token)
            or not token.isascii()
            or len(token) > _MAX_BEARER_BYTES
        ):
            raise AuthenticationError("invalid bearer token")
        await self._lookup_slots.acquire()
        loop = asyncio.get_running_loop()
        try:
            verification = loop.run_in_executor(None, self._verify_token, token)
        except BaseException:
            self._lookup_slots.release()
            raise
        # Caller cancellation cannot stop a running thread. Release admission only
        # when that worker really finishes; shield also retrieves its eventual result.
        verification.add_done_callback(lambda _: self._lookup_slots.release())
        return await asyncio.shield(verification)

    def _verify_token(self, token: str) -> VerifiedJwt:
        try:
            header = jwt.get_unverified_header(token)
        except PyJWTError as exc:
            raise AuthenticationError("invalid bearer token") from exc
        algorithm = header.get("alg")
        key_id = header.get("kid")
        if algorithm not in self._config.algorithms:
            raise AuthenticationError("invalid bearer token")
        try:
            _bounded_visible(key_id, field="JWT kid", maximum=512)
        except ValueError as exc:
            raise AuthenticationError("invalid bearer token") from exc

        try:
            signing_key = self._signing_keys.signing_key(token)
        except PyJWKClientConnectionError as exc:
            raise IdentityProviderUnavailable() from exc
        except PyJWTError as exc:
            raise AuthenticationError("invalid bearer token") from exc

        key_algorithm = getattr(signing_key, "algorithm_name", algorithm)
        if key_algorithm != algorithm:
            raise AuthenticationError("invalid bearer token")
        try:
            claims = jwt.decode(
                token,
                key=signing_key,
                algorithms=[algorithm],
                issuer=self._config.issuer,
                audience=self._config.audience,
                leeway=self._config.leeway_seconds,
                options={
                    "require": ["exp", "sub"],
                    "verify_signature": True,
                    "verify_exp": True,
                    "verify_nbf": True,
                    "verify_iss": True,
                    "verify_aud": True,
                    "verify_sub": True,
                    "strict_aud": True,
                },
            )
        except PyJWTError as exc:
            raise AuthenticationError("invalid bearer token") from exc

        if type(claims.get("exp")) is not int or (
            "nbf" in claims and type(claims.get("nbf")) is not int
        ):
            raise AuthenticationError("invalid bearer token")
        user_id = _subject_claim(claims.get("sub"))
        email = _verified_email(claims)
        return VerifiedJwt(
            user_id=user_id,
            email=email,
            claims=MappingProxyType(dict(claims)),
        )


class PersonalJwtAuthAdapter:
    """Map one verified stable host subject to one personal billing account."""

    def __init__(self, verifier: JwtVerifier) -> None:
        self._verifier = verifier

    async def authenticate(self, request: Request) -> AuthenticatedIdentity:
        principal = await self._verifier.verify_request(request)
        return AuthenticatedIdentity(
            external_ref=_owner_reference(_USER_OWNER_PREFIX, principal.user_id),
            email=principal.email,
        )


class TeamBillingRole(StrEnum):
    VIEWER = "viewer"
    BILLING_ADMIN = "billing_admin"


class TeamBillingCapability(StrEnum):
    CATALOG_READ = "catalog:read"
    ACCOUNT_READ = "account:read"
    CHECKOUT_CREATE = "checkout:create"
    CREDIT_PACK_CHECKOUT_CREATE = "credit_pack_checkout:create"
    PORTAL_OPEN = "portal:open"
    PLAN_CHANGE = "plan:change"
    UNKNOWN_BILLING_OPERATION = "billing:unknown"


@dataclass(frozen=True, slots=True)
class TeamMembership:
    user_id: UUID | str
    tenant_id: UUID | str
    role: TeamBillingRole


class TeamMembershipRepository(Protocol):
    async def membership_for(
        self, user_id: UUID | str, tenant_id: UUID | str
    ) -> TeamMembership | None: ...


class TeamBillingAuthorizationPolicy:
    """Explicit route-to-capability policy; unknown billing routes fail closed for viewers."""

    _RELATIVE_ROUTES = MappingProxyType(
        {
            ("GET", "/api/catalog"): TeamBillingCapability.CATALOG_READ,
            ("GET", "/billing/catalog"): TeamBillingCapability.CATALOG_READ,
            ("GET", "/api/account"): TeamBillingCapability.ACCOUNT_READ,
            ("GET", "/billing/account"): TeamBillingCapability.ACCOUNT_READ,
            ("POST", "/api/checkout"): TeamBillingCapability.CHECKOUT_CREATE,
            ("POST", "/billing/checkout"): TeamBillingCapability.CHECKOUT_CREATE,
            (
                "POST",
                "/api/credit-packs/checkout",
            ): TeamBillingCapability.CREDIT_PACK_CHECKOUT_CREATE,
            ("POST", "/api/billing/portal"): TeamBillingCapability.PORTAL_OPEN,
            ("POST", "/billing/portal"): TeamBillingCapability.PORTAL_OPEN,
            ("POST", "/api/billing/change/preview"): TeamBillingCapability.PLAN_CHANGE,
            ("POST", "/billing/plan-change/preview"): TeamBillingCapability.PLAN_CHANGE,
            ("POST", "/api/billing/change/confirm"): TeamBillingCapability.PLAN_CHANGE,
            ("POST", "/billing/plan-change/confirm"): TeamBillingCapability.PLAN_CHANGE,
        }
    )

    def __init__(self, *, billing_prefix: str = "") -> None:
        self.billing_prefix = normalize_billing_prefix(billing_prefix)
        self._routes = MappingProxyType(
            {
                (method, f"{self.billing_prefix}{path}"): capability
                for (method, path), capability in self._RELATIVE_ROUTES.items()
            }
        )

    def capability_for(self, request: Request) -> TeamBillingCapability:
        return self._routes.get(
            (request.method.upper(), get_route_path(request.scope)),
            TeamBillingCapability.UNKNOWN_BILLING_OPERATION,
        )

    def require(self, membership: TeamMembership, capability: TeamBillingCapability) -> None:
        if membership.role is TeamBillingRole.BILLING_ADMIN:
            return
        if (
            membership.role is TeamBillingRole.VIEWER
            and capability is TeamBillingCapability.CATALOG_READ
        ):
            return
        raise HTTPException(403, "billing administrator permission required")


class TeamJwtAuthAdapter:
    """Resolve a signed tenant selector, then prove current host membership server-side."""

    def __init__(
        self,
        verifier: JwtVerifier,
        memberships: TeamMembershipRepository,
        *,
        tenant_claim: str = "tenant_id",
        authorization: TeamBillingAuthorizationPolicy | None = None,
    ) -> None:
        self._verifier = verifier
        self._memberships = memberships
        self._tenant_claim = _bounded_visible(tenant_claim, field="tenant claim name", maximum=128)
        self._authorization = authorization or TeamBillingAuthorizationPolicy()

    async def authenticate(self, request: Request) -> AuthenticatedIdentity:
        principal = await self._verifier.verify_request(request)
        tenant_id = _stable_identity_claim(
            principal.claims.get(self._tenant_claim),
            field=self._tenant_claim,
            maximum=_MAX_OWNER_REFERENCE_BYTES - len(_TENANT_OWNER_PREFIX),
        )
        membership = await self._memberships.membership_for(principal.user_id, tenant_id)
        if membership is None:
            raise HTTPException(403, "tenant membership required")
        if membership.user_id != principal.user_id or membership.tenant_id != tenant_id:
            raise RuntimeError("membership repository returned a mismatched identity")
        if type(membership.role) is not TeamBillingRole:
            raise RuntimeError("membership repository returned an invalid billing role")
        capability = self._authorization.capability_for(request)
        self._authorization.require(membership, capability)
        return AuthenticatedIdentity(
            external_ref=_owner_reference(_TENANT_OWNER_PREFIX, tenant_id),
            email=principal.email,
        )
