from __future__ import annotations

import asyncio
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import asyncpg
import httpx
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import FastAPI, HTTPException
from jwt.algorithms import RSAAlgorithm
from jwt.exceptions import PyJWKClientConnectionError, PyJWKClientError
from starlette.requests import Request

from examples.auth_starters.personal_app import create_host_app as create_personal_app
from examples.auth_starters.team_app import (
    PostgresTeamMembershipRepository,
)
from examples.auth_starters.team_app import (
    create_host_app as create_team_app,
)
from stripe_entitlements.auth import AuthenticationError
from stripe_entitlements.auth_starters import (
    IdentityProviderUnavailable,
    JwtVerificationConfig,
    JwtVerifier,
    PersonalJwtAuthAdapter,
    PyJwksSigningKeyProvider,
    TeamBillingAuthorizationPolicy,
    TeamBillingCapability,
    TeamBillingRole,
    TeamJwtAuthAdapter,
    TeamMembership,
)
from stripe_entitlements.config import Settings, get_settings
from stripe_entitlements.database import Database
from stripe_entitlements.integration import install_billing
from stripe_entitlements.kernel import BillingKernel
from tests.conftest import TEST_DSN

ISSUER = "https://identity.example.test/"
AUDIENCE = "billing-api"
USER_ID = UUID("bcd14e19-2c8f-42aa-aeb5-e419d3477cc9")
TENANT_A = UUID("88a213a7-3424-4260-b964-fd082d776b10")
TENANT_B = UUID("dd5163d1-c81c-48e7-8668-f62629c2bc21")
ADMIN_USER_ID = UUID("96da8316-d8dd-4d29-b51c-d04123845503")


@pytest.fixture(scope="module")
def signing_keys() -> tuple[Any, Any]:
    private_key = rsa.generate_private_key(public_exponent=65_537, key_size=2048)
    return private_key, private_key.public_key()


@dataclass
class StaticSigningKeys:
    key: Any
    calls: int = 0

    def signing_key(self, token: str) -> Any:
        del token
        self.calls += 1
        return self.key


@dataclass
class RaisingSigningKeys:
    exception: PyJWTErrorForTest

    def signing_key(self, token: str) -> Any:
        del token
        raise self.exception


PyJWTErrorForTest = PyJWKClientConnectionError | PyJWKClientError


class BlockingSigningKeys:
    def __init__(self, key: Any, *, expected_active: int) -> None:
        self.key = key
        self.expected_active = expected_active
        self.release = threading.Event()
        self.capacity_reached = threading.Event()
        self.drained = threading.Event()
        self.drained.set()
        self.fail_after_release = True
        self._lock = threading.Lock()
        self.started = 0
        self.active = 0
        self.max_active = 0

    def signing_key(self, token: str) -> Any:
        del token
        with self._lock:
            self.started += 1
            self.active += 1
            self.max_active = max(self.max_active, self.active)
            self.drained.clear()
            if self.active == self.expected_active:
                self.capacity_reached.set()
        try:
            if not self.release.wait(timeout=5):
                raise RuntimeError("test signing-key provider was not released")
            if self.fail_after_release:
                raise PyJWKClientError("private canceled-worker failure")
            return self.key
        finally:
            with self._lock:
                self.active -= 1
                if self.active == 0:
                    self.drained.set()

    def counts(self) -> tuple[int, int, int]:
        with self._lock:
            return self.started, self.active, self.max_active


def verification_config(**overrides: Any) -> JwtVerificationConfig:
    values: dict[str, Any] = {
        "issuer": ISSUER,
        "audience": AUDIENCE,
        "jwks_url": "https://identity.example.test/.well-known/jwks.json",
        "algorithms": ("RS256",),
    }
    values.update(overrides)
    return JwtVerificationConfig(**values)


def token_for(
    private_key: Any,
    *,
    claims: dict[str, Any] | None = None,
    remove: frozenset[str] = frozenset(),
    algorithm: str = "RS256",
    key: Any | None = None,
    kid: object = "test-key-1",
) -> str:
    now = int(time.time())
    payload: dict[str, Any] = {
        "iss": ISSUER,
        "aud": AUDIENCE,
        "sub": str(USER_ID),
        "iat": now,
        "nbf": now - 1,
        "exp": now + 300,
    }
    payload.update(claims or {})
    for claim in remove:
        payload.pop(claim, None)
    return jwt.encode(
        payload,
        private_key if key is None else key,
        algorithm=algorithm,
        headers={} if kid is None else {"kid": kid},
    )


def request_for(
    authorization: str,
    *,
    method: str = "GET",
    path: str = "/api/catalog",
    root_path: str = "",
    extra_headers: tuple[tuple[bytes, bytes], ...] = (),
) -> Request:
    headers = ((b"authorization", authorization.encode("utf-8")), *extra_headers)
    return Request(
        {
            "type": "http",
            "http_version": "1.1",
            "scheme": "https",
            "method": method,
            "path": path,
            "root_path": root_path,
            "raw_path": path.encode("ascii"),
            "query_string": b"",
            "headers": list(headers),
            "client": ("127.0.0.1", 12345),
            "server": ("billing.example.test", 443),
        }
    )


def verifier_for(public_key: Any) -> tuple[JwtVerifier, StaticSigningKeys]:
    provider = StaticSigningKeys(public_key)
    return JwtVerifier(verification_config(), signing_keys=provider), provider


@pytest.mark.parametrize(
    "overrides",
    [
        {"jwks_url": "http://identity.example.test/jwks.json"},
        {"jwks_url": "https://user:pass@identity.example.test/jwks.json"},
        {"jwks_url": "https://identity.example.test/jwks.json#fragment"},
        {"algorithms": ("HS256",)},
        {"algorithms": ("RS256", "RS256")},
        {"algorithms": ()},
        {"leeway_seconds": 301},
        {"jwks_cache_seconds": 86_401},
        {"jwks_timeout_seconds": 0},
        {"jwks_refresh_cooldown_seconds": 0},
        {"jwks_refresh_cooldown_seconds": 61},
        {"jwks_max_concurrent_lookups": 0},
        {"jwks_max_concurrent_lookups": 65},
        {"jwks_unknown_kid_cache_size": 0},
        {"jwks_unknown_kid_cache_size": 4097},
        {"jwks_unknown_kid_ttl_seconds": 0},
        {"jwks_unknown_kid_ttl_seconds": 301},
        {"jwks_cache_seconds": 4, "jwks_refresh_cooldown_seconds": 5},
    ],
)
def test_verification_configuration_rejects_unsafe_or_unbounded_values(
    overrides: dict[str, Any],
) -> None:
    with pytest.raises(ValueError):
        verification_config(**overrides)


async def test_personal_adapter_uses_only_verified_subject_and_verified_email(
    signing_keys: tuple[Any, Any],
) -> None:
    private_key, public_key = signing_keys
    verifier, _ = verifier_for(public_key)
    adapter = PersonalJwtAuthAdapter(verifier)
    token = token_for(
        private_key,
        claims={"email": "person@example.test", "email_verified": True},
    )

    identity = await adapter.authenticate(
        request_for(
            f"Bearer {token}",
            extra_headers=((b"x-user-id", str(uuid4()).encode("ascii")),),
        )
    )

    assert identity.external_ref == f"v1:user:{USER_ID}"
    assert identity.email == "person@example.test"


@pytest.mark.parametrize("include_nbf", [True, False])
async def test_personal_adapter_accepts_an_opaque_subject_and_optional_nbf(
    include_nbf: bool,
    signing_keys: tuple[Any, Any],
) -> None:
    private_key, public_key = signing_keys
    verifier, _ = verifier_for(public_key)
    remove = frozenset() if include_nbf else frozenset({"nbf"})
    token = token_for(private_key, claims={"sub": "user_provider_123"}, remove=remove)

    identity = await PersonalJwtAuthAdapter(verifier).authenticate(request_for(f"Bearer {token}"))

    assert identity.external_ref == "v1:user:user_provider_123"


@pytest.mark.parametrize(
    "subject",
    [
        "auth0|provider-user-123",
        str(USER_ID).upper(),
        "00000000-0000-0000-0000-000000000000",
    ],
)
async def test_personal_adapter_preserves_opaque_subject_exactly(
    subject: str,
    signing_keys: tuple[Any, Any],
) -> None:
    private_key, public_key = signing_keys
    verifier, _ = verifier_for(public_key)
    token = token_for(private_key, claims={"sub": subject})

    identity = await PersonalJwtAuthAdapter(verifier).authenticate(request_for(f"Bearer {token}"))

    assert identity.external_ref == f"v1:user:{subject}"


async def test_personal_subject_bound_includes_the_owner_reference_prefix(
    signing_keys: tuple[Any, Any],
) -> None:
    private_key, public_key = signing_keys
    verifier, _ = verifier_for(public_key)
    accepted = "a" * 504
    rejected = "a" * 505

    identity = await PersonalJwtAuthAdapter(verifier).authenticate(
        request_for(f"Bearer {token_for(private_key, claims={'sub': accepted})}")
    )
    with pytest.raises(AuthenticationError, match="invalid bearer token"):
        await PersonalJwtAuthAdapter(verifier).authenticate(
            request_for(f"Bearer {token_for(private_key, claims={'sub': rejected})}")
        )

    assert len(identity.external_ref.encode("utf-8")) == 512


@pytest.mark.parametrize("email_verified", [False, "true", 1, None])
async def test_unverified_email_is_never_forwarded(
    signing_keys: tuple[Any, Any], email_verified: object
) -> None:
    private_key, public_key = signing_keys
    verifier, _ = verifier_for(public_key)
    token = token_for(
        private_key,
        claims={"email": "untrusted@example.test", "email_verified": email_verified},
    )

    principal = await verifier.verify_request(request_for(f"Bearer {token}"))

    assert principal.email is None


async def test_malformed_verified_email_fails_closed(signing_keys: tuple[Any, Any]) -> None:
    private_key, public_key = signing_keys
    verifier, _ = verifier_for(public_key)
    token = token_for(
        private_key,
        claims={"email": "not-an-email", "email_verified": True},
    )

    with pytest.raises(AuthenticationError, match="invalid bearer token"):
        await verifier.verify_request(request_for(f"Bearer {token}"))


@pytest.mark.parametrize(
    ("claims", "remove"),
    [
        ({"iss": "https://attacker.example.test/"}, frozenset()),
        ({"aud": "another-api"}, frozenset()),
        ({"aud": [AUDIENCE, "another-api"]}, frozenset()),
        ({"exp": 1}, frozenset()),
        ({"exp": int(time.time()) + 300.5}, frozenset()),
        ({"nbf": int(time.time()) + 600}, frozenset()),
        ({"nbf": False}, frozenset()),
        ({"sub": ""}, frozenset()),
        ({"sub": " user_provider_123"}, frozenset()),
        ({"sub": "user\nprovider"}, frozenset()),
        ({"sub": [str(USER_ID)]}, frozenset()),
        ({}, frozenset({"exp"})),
        ({}, frozenset({"sub"})),
    ],
)
async def test_wrong_issuer_audience_time_or_subject_claims_fail_closed(
    signing_keys: tuple[Any, Any], claims: dict[str, Any], remove: frozenset[str]
) -> None:
    private_key, public_key = signing_keys
    verifier, _ = verifier_for(public_key)
    token = token_for(private_key, claims=claims, remove=remove)

    with pytest.raises(AuthenticationError, match="invalid bearer token"):
        await verifier.verify_request(request_for(f"Bearer {token}"))


async def test_wrong_algorithm_is_rejected_before_any_key_lookup(
    signing_keys: tuple[Any, Any],
) -> None:
    private_key, public_key = signing_keys
    del private_key
    verifier, provider = verifier_for(public_key)
    token = token_for(
        b"a-test-secret-with-enough-entropy",
        algorithm="HS256",
        key=b"a-test-secret-with-enough-entropy",
    )

    with pytest.raises(AuthenticationError, match="invalid bearer token"):
        await verifier.verify_request(request_for(f"Bearer {token}"))
    assert provider.calls == 0


async def test_invalid_signature_is_rejected(signing_keys: tuple[Any, Any]) -> None:
    _, public_key = signing_keys
    attacker_key = rsa.generate_private_key(public_exponent=65_537, key_size=2048)
    verifier, _ = verifier_for(public_key)
    token = token_for(attacker_key)

    with pytest.raises(AuthenticationError, match="invalid bearer token"):
        await verifier.verify_request(request_for(f"Bearer {token}"))


@pytest.mark.parametrize(
    "authorization",
    [
        "",
        "Basic abc.def.ghi",
        "Bearer",
        "Bearer  abc.def.ghi",
        "Bearer abc.def.ghi extra",
        "Bearer ☃",
        "Bearer not-a-jwt",
    ],
)
async def test_malformed_authorization_or_jwt_is_rejected(
    signing_keys: tuple[Any, Any], authorization: str
) -> None:
    _, public_key = signing_keys
    verifier, _ = verifier_for(public_key)

    with pytest.raises(AuthenticationError, match="invalid bearer token"):
        await verifier.verify_request(request_for(authorization))


async def test_missing_kid_is_rejected_before_key_lookup(signing_keys: tuple[Any, Any]) -> None:
    private_key, public_key = signing_keys
    verifier, provider = verifier_for(public_key)
    token = token_for(private_key, kid=None)

    with pytest.raises(AuthenticationError, match="invalid bearer token"):
        await verifier.verify_request(request_for(f"Bearer {token}"))
    assert provider.calls == 0


async def test_jwks_transport_failure_is_a_sanitized_retryable_503(
    signing_keys: tuple[Any, Any],
) -> None:
    private_key, _ = signing_keys
    verifier = JwtVerifier(
        verification_config(),
        signing_keys=RaisingSigningKeys(PyJWKClientConnectionError("private detail")),
    )
    token = token_for(private_key)

    with pytest.raises(IdentityProviderUnavailable) as caught:
        await verifier.verify_request(request_for(f"Bearer {token}"))

    assert caught.value.status_code == 503
    assert caught.value.detail == "identity provider temporarily unavailable"
    assert "private detail" not in str(caught.value.detail)


@pytest.mark.parametrize("jwks", [{"keys": []}, [], {"keys": "not-a-list"}])
async def test_empty_or_malformed_jwks_is_a_sanitized_retryable_503(
    signing_keys: tuple[Any, Any],
    monkeypatch: pytest.MonkeyPatch,
    jwks: object,
) -> None:
    private_key, _ = signing_keys
    provider = PyJwksSigningKeyProvider(verification_config())
    monkeypatch.setattr(provider._client, "fetch_data", lambda: jwks)
    verifier = JwtVerifier(verification_config(), signing_keys=provider)

    with pytest.raises(IdentityProviderUnavailable) as caught:
        await verifier.verify_request(request_for(f"Bearer {token_for(private_key)}"))

    assert caught.value.status_code == 503
    assert caught.value.detail == "identity provider temporarily unavailable"


async def test_unknown_kid_failure_is_an_authentication_error(
    signing_keys: tuple[Any, Any],
) -> None:
    private_key, _ = signing_keys
    verifier = JwtVerifier(
        verification_config(),
        signing_keys=RaisingSigningKeys(PyJWKClientError("unknown kid")),
    )
    token = token_for(private_key)

    with pytest.raises(AuthenticationError, match="invalid bearer token"):
        await verifier.verify_request(request_for(f"Bearer {token}"))


async def test_verifier_bounds_worker_admission_until_canceled_workers_really_finish(
    signing_keys: tuple[Any, Any],
) -> None:
    private_key, public_key = signing_keys
    lookup_limit = 3
    provider = BlockingSigningKeys(public_key, expected_active=lookup_limit)
    verifier = JwtVerifier(
        verification_config(jwks_max_concurrent_lookups=lookup_limit),
        signing_keys=provider,
    )
    token = token_for(private_key)
    loop = asyncio.get_running_loop()
    unhandled: list[dict[str, Any]] = []
    previous_handler = loop.get_exception_handler()
    loop.set_exception_handler(lambda _loop, context: unhandled.append(context))
    tasks = [
        asyncio.create_task(verifier.verify_request(request_for(f"Bearer {token}")))
        for _ in range(24)
    ]

    try:
        reached = await asyncio.wait_for(
            asyncio.to_thread(provider.capacity_reached.wait), timeout=2
        )
        assert reached is True
        assert provider.counts() == (lookup_limit, lookup_limit, lookup_limit)

        for task in tasks:
            task.cancel()
        outcomes = await asyncio.gather(*tasks, return_exceptions=True)
        assert all(isinstance(outcome, asyncio.CancelledError) for outcome in outcomes)

        # Cancellation stops queued callers, but it cannot stop their running threads.
        # No permit may be returned until those exact workers leave the provider.
        await asyncio.sleep(0.05)
        assert provider.counts() == (lookup_limit, lookup_limit, lookup_limit)

        provider.release.set()
        drained = await asyncio.wait_for(asyncio.to_thread(provider.drained.wait), timeout=2)
        assert drained is True
        provider.fail_after_release = False

        principal = await asyncio.wait_for(
            verifier.verify_request(request_for(f"Bearer {token}")), timeout=2
        )
        assert principal.user_id == USER_ID
        assert provider.counts() == (lookup_limit + 1, 0, lookup_limit)
        await asyncio.sleep(0)
        assert unhandled == []
    finally:
        provider.release.set()
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        loop.set_exception_handler(previous_handler)


def _public_jwk(public_key: Any, kid: str) -> dict[str, Any]:
    value = RSAAlgorithm.to_jwk(public_key, as_dict=True)
    assert isinstance(value, dict)
    value.update({"kid": kid, "use": "sig", "alg": "RS256"})
    return value


def test_production_jwks_provider_recovers_real_rotation_after_global_cooldown(
    signing_keys: tuple[Any, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    private_key, public_key = signing_keys
    stale_private_key = rsa.generate_private_key(public_exponent=65_537, key_size=2048)
    provider = PyJwksSigningKeyProvider(verification_config())
    clock = [0.0]
    monkeypatch.setattr(provider, "_monotonic", lambda: clock[0])
    responses = iter(
        [
            {"keys": [_public_jwk(stale_private_key.public_key(), "stale-key")]},
            {"keys": [_public_jwk(public_key, "rotated-key")]},
        ]
    )
    fetches = 0

    def fetch_data() -> dict[str, Any]:
        nonlocal fetches
        fetches += 1
        return next(responses)

    monkeypatch.setattr(provider._client, "fetch_data", fetch_data)
    stale_token = token_for(stale_private_key, kid="stale-key")
    token = token_for(private_key, kid="rotated-key")

    assert provider.signing_key(stale_token).key_id == "stale-key"
    clock[0] = 4.999
    with pytest.raises(PyJWKClientError, match="rotated-key"):
        provider.signing_key(token)
    assert fetches == 1

    clock[0] = 5.001
    key = provider.signing_key(token)

    assert key.key_id == "rotated-key"
    assert fetches == 2


def test_production_jwks_provider_stops_after_one_failed_refresh(
    signing_keys: tuple[Any, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    private_key, _ = signing_keys
    stale_key = rsa.generate_private_key(public_exponent=65_537, key_size=2048)
    provider = PyJwksSigningKeyProvider(verification_config())
    clock = [0.0]
    monkeypatch.setattr(provider, "_monotonic", lambda: clock[0])
    fetches = 0

    def fetch_data() -> dict[str, Any]:
        nonlocal fetches
        fetches += 1
        return {"keys": [_public_jwk(stale_key.public_key(), "stale-key")]}

    monkeypatch.setattr(provider._client, "fetch_data", fetch_data)
    stale_token = token_for(stale_key, kid="stale-key")
    assert provider.signing_key(stale_token).key_id == "stale-key"
    clock[0] = 5.001
    token = token_for(private_key, kid="never-present")

    with pytest.raises(PyJWKClientError, match="never-present"):
        provider.signing_key(token)
    assert fetches == 2

    with pytest.raises(PyJWKClientError, match="never-present-again"):
        provider.signing_key(token_for(private_key, kid="never-present-again"))
    assert fetches == 2


async def test_distinct_concurrent_unknown_kids_share_one_refresh_budget(
    signing_keys: tuple[Any, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    private_key, _ = signing_keys
    stale_key = rsa.generate_private_key(public_exponent=65_537, key_size=2048)
    provider = PyJwksSigningKeyProvider(verification_config())
    clock = [0.0]
    monkeypatch.setattr(provider, "_monotonic", lambda: clock[0])
    fetches = 0

    def fetch_data() -> dict[str, Any]:
        nonlocal fetches
        fetches += 1
        return {"keys": [_public_jwk(stale_key.public_key(), "stale-key")]}

    monkeypatch.setattr(provider._client, "fetch_data", fetch_data)
    stale_token = token_for(stale_key, kid="stale-key")
    assert provider.signing_key(stale_token).key_id == "stale-key"
    clock[0] = 5.001
    tokens = [token_for(private_key, kid=f"random-attacker-kid-{index}") for index in range(32)]

    results = await asyncio.gather(
        *(asyncio.to_thread(provider.signing_key, token) for token in tokens),
        return_exceptions=True,
    )

    assert all(isinstance(result, PyJWKClientError) for result in results)
    assert fetches == 2  # one cold fill plus exactly one cross-kid miss refresh
    assert provider.signing_key(stale_token).key_id == "stale-key"
    assert fetches == 2


async def test_same_kid_cold_start_requests_coalesce_one_jwks_fetch(
    signing_keys: tuple[Any, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    private_key, public_key = signing_keys
    config = verification_config(jwks_max_concurrent_lookups=8)
    provider = PyJwksSigningKeyProvider(config)
    refresh_started = threading.Event()
    release_refresh = threading.Event()
    fetches = 0

    def fetch_data() -> dict[str, Any]:
        nonlocal fetches
        fetches += 1
        refresh_started.set()
        if not release_refresh.wait(timeout=5):
            raise RuntimeError("test JWKS refresh was not released")
        return {"keys": [_public_jwk(public_key, "cold-key")]}

    monkeypatch.setattr(provider._client, "fetch_data", fetch_data)
    verifier = JwtVerifier(config, signing_keys=provider)
    token = token_for(private_key, kid="cold-key")
    tasks = [
        asyncio.create_task(verifier.verify_request(request_for(f"Bearer {token}")))
        for _ in range(8)
    ]

    try:
        started = await asyncio.wait_for(asyncio.to_thread(refresh_started.wait), timeout=2)
        assert started is True
        await asyncio.sleep(0.05)
        assert all(not task.done() for task in tasks)
    finally:
        release_refresh.set()

    principals = await asyncio.wait_for(asyncio.gather(*tasks), timeout=2)
    assert all(principal.user_id == USER_ID for principal in principals)
    assert fetches == 1


async def test_expired_known_key_after_refresh_failure_stays_retryable_503(
    signing_keys: tuple[Any, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    private_key, public_key = signing_keys
    config = verification_config(jwks_cache_seconds=5, jwks_refresh_cooldown_seconds=5)
    provider = PyJwksSigningKeyProvider(config)
    clock = [0.0]
    fetches = 0

    def fetch_data() -> dict[str, Any]:
        nonlocal fetches
        fetches += 1
        if fetches == 1:
            return {"keys": [_public_jwk(public_key, "known-key")]}
        raise PyJWKClientConnectionError("private provider outage")

    monkeypatch.setattr(provider, "_monotonic", lambda: clock[0])
    monkeypatch.setattr(provider._client, "fetch_data", fetch_data)
    verifier = JwtVerifier(config, signing_keys=provider)
    request = request_for(f"Bearer {token_for(private_key, kid='known-key')}")

    assert (await verifier.verify_request(request)).user_id == USER_ID
    clock[0] = 5.001
    with pytest.raises(IdentityProviderUnavailable):
        await verifier.verify_request(request)
    clock[0] = 6.0
    with pytest.raises(IdentityProviderUnavailable):
        await verifier.verify_request(request)

    assert fetches == 2


async def test_same_known_kid_coalesces_one_refresh_after_cache_ttl(
    signing_keys: tuple[Any, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    private_key, public_key = signing_keys
    config = verification_config(
        jwks_cache_seconds=5,
        jwks_refresh_cooldown_seconds=5,
        jwks_max_concurrent_lookups=8,
    )
    provider = PyJwksSigningKeyProvider(config)
    clock = [0.0]
    refresh_started = threading.Event()
    release_refresh = threading.Event()
    fetches = 0

    def fetch_data() -> dict[str, Any]:
        nonlocal fetches
        fetches += 1
        if fetches == 2:
            refresh_started.set()
            if not release_refresh.wait(timeout=5):
                raise RuntimeError("test JWKS refresh was not released")
        return {"keys": [_public_jwk(public_key, "known-key")]}

    monkeypatch.setattr(provider, "_monotonic", lambda: clock[0])
    monkeypatch.setattr(provider._client, "fetch_data", fetch_data)
    verifier = JwtVerifier(config, signing_keys=provider)
    token = token_for(private_key, kid="known-key")
    assert (await verifier.verify_request(request_for(f"Bearer {token}"))).user_id == USER_ID

    clock[0] = 5.001
    tasks = [
        asyncio.create_task(verifier.verify_request(request_for(f"Bearer {token}")))
        for _ in range(8)
    ]
    try:
        started = await asyncio.wait_for(asyncio.to_thread(refresh_started.wait), timeout=2)
        assert started is True
        await asyncio.sleep(0.05)
        assert all(not task.done() for task in tasks)
    finally:
        release_refresh.set()

    principals = await asyncio.wait_for(asyncio.gather(*tasks), timeout=2)
    assert all(principal.user_id == USER_ID for principal in principals)
    assert fetches == 2


def test_unknown_kid_negative_cache_is_ttl_bounded_lru(
    signing_keys: tuple[Any, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    private_key, _ = signing_keys
    stale_key = rsa.generate_private_key(public_exponent=65_537, key_size=2048)
    provider = PyJwksSigningKeyProvider(
        verification_config(
            jwks_refresh_cooldown_seconds=5,
            jwks_unknown_kid_cache_size=2,
            jwks_unknown_kid_ttl_seconds=2,
        )
    )
    clock = [0.0]
    monkeypatch.setattr(provider, "_monotonic", lambda: clock[0])
    fetches = 0

    def fetch_data() -> dict[str, Any]:
        nonlocal fetches
        fetches += 1
        return {"keys": [_public_jwk(stale_key.public_key(), "stale-key")]}

    monkeypatch.setattr(provider._client, "fetch_data", fetch_data)
    assert provider.signing_key(token_for(stale_key, kid="stale-key")).key_id == "stale-key"

    for key_id in ("unknown-a", "unknown-b", "unknown-c"):
        with pytest.raises(PyJWKClientError, match=key_id):
            provider.signing_key(token_for(private_key, kid=key_id))

    assert list(provider._unknown_kids) == ["unknown-b", "unknown-c"]
    with pytest.raises(PyJWKClientError, match="unknown-b"):
        provider.signing_key(token_for(private_key, kid="unknown-b"))
    with pytest.raises(PyJWKClientError, match="unknown-d"):
        provider.signing_key(token_for(private_key, kid="unknown-d"))
    assert list(provider._unknown_kids) == ["unknown-b", "unknown-d"]
    assert fetches == 1

    clock[0] = 2.001
    with pytest.raises(PyJWKClientError, match="unknown-b"):
        provider.signing_key(token_for(private_key, kid="unknown-b"))

    assert fetches == 1
    assert list(provider._unknown_kids) == ["unknown-d", "unknown-b"]


def test_transport_failure_does_not_poison_unknown_kid_cache(
    signing_keys: tuple[Any, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    private_key, _ = signing_keys
    provider = PyJwksSigningKeyProvider(verification_config())

    def fetch_data() -> dict[str, Any]:
        raise PyJWKClientConnectionError("private transport failure")

    monkeypatch.setattr(provider._client, "fetch_data", fetch_data)
    with pytest.raises(PyJWKClientConnectionError, match="private transport failure"):
        provider.signing_key(token_for(private_key, kid="not-observed-as-unknown"))

    assert provider._unknown_kids == {}


async def test_slow_unknown_refresh_does_not_block_cached_known_tokens(
    signing_keys: tuple[Any, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    private_key, _ = signing_keys
    stale_key = rsa.generate_private_key(public_exponent=65_537, key_size=2048)
    config = verification_config(jwks_max_concurrent_lookups=8)
    provider = PyJwksSigningKeyProvider(config)
    clock = [0.0]
    monkeypatch.setattr(provider, "_monotonic", lambda: clock[0])
    refresh_started = threading.Event()
    release_refresh = threading.Event()
    fetches = 0

    def fetch_data() -> dict[str, Any]:
        nonlocal fetches
        fetches += 1
        if fetches > 1:
            refresh_started.set()
            if not release_refresh.wait(timeout=5):
                raise RuntimeError("test JWKS refresh was not released")
        return {"keys": [_public_jwk(stale_key.public_key(), "stale-key")]}

    monkeypatch.setattr(provider._client, "fetch_data", fetch_data)
    stale_token = token_for(stale_key, kid="stale-key")
    assert provider.signing_key(stale_token).key_id == "stale-key"
    clock[0] = 5.001
    verifier = JwtVerifier(config, signing_keys=provider)
    first_unknown = asyncio.create_task(
        verifier.verify_request(
            request_for(f"Bearer {token_for(private_key, kid='unknown-blocking')}"),
        )
    )

    try:
        started = await asyncio.wait_for(asyncio.to_thread(refresh_started.wait), timeout=2)
        assert started is True
        attacker_requests = [
            verifier.verify_request(
                request_for(f"Bearer {token_for(private_key, kid=f'unknown-fast-{index}')}")
            )
            for index in range(32)
        ]
        attacker_results = await asyncio.wait_for(
            asyncio.gather(*attacker_requests, return_exceptions=True),
            timeout=2,
        )
        assert all(isinstance(result, IdentityProviderUnavailable) for result in attacker_results)

        principal = await asyncio.wait_for(
            verifier.verify_request(request_for(f"Bearer {stale_token}")), timeout=2
        )
        assert principal.user_id == USER_ID
        assert fetches == 2
        assert not first_unknown.done()
    finally:
        release_refresh.set()

    with pytest.raises(AuthenticationError, match="invalid bearer token"):
        await asyncio.wait_for(first_unknown, timeout=2)
    assert fetches == 2


async def test_unknown_kid_refresh_error_remains_sanitized_at_auth_boundary(
    signing_keys: tuple[Any, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    private_key, _ = signing_keys
    stale_key = rsa.generate_private_key(public_exponent=65_537, key_size=2048)
    provider = PyJwksSigningKeyProvider(verification_config())
    clock = [0.0]
    monkeypatch.setattr(provider, "_monotonic", lambda: clock[0])
    monkeypatch.setattr(
        provider._client,
        "fetch_data",
        lambda: {"keys": [_public_jwk(stale_key.public_key(), "stale-key")]},
    )
    assert provider.signing_key(token_for(stale_key, kid="stale-key")).key_id == "stale-key"
    clock[0] = 5.001
    secret_kid = "private-tenant-key-id"
    verifier = JwtVerifier(verification_config(), signing_keys=provider)

    with pytest.raises(AuthenticationError) as caught:
        await verifier.verify_request(
            request_for(f"Bearer {token_for(private_key, kid=secret_kid)}")
        )

    assert str(caught.value) == "invalid bearer token"
    assert secret_kid not in str(caught.value)


class MemoryMemberships:
    def __init__(self, *memberships: TeamMembership) -> None:
        self._memberships = {
            (membership.user_id, membership.tenant_id): membership for membership in memberships
        }
        self.queries: list[tuple[UUID | str, UUID | str]] = []

    async def membership_for(
        self, user_id: UUID | str, tenant_id: UUID | str
    ) -> TeamMembership | None:
        self.queries.append((user_id, tenant_id))
        return self._memberships.get((user_id, tenant_id))


def team_adapter(
    public_key: Any,
    role: TeamBillingRole,
    *,
    tenant_id: UUID | str = TENANT_A,
    authorization: TeamBillingAuthorizationPolicy | None = None,
) -> tuple[TeamJwtAuthAdapter, MemoryMemberships]:
    verifier, _ = verifier_for(public_key)
    memberships = MemoryMemberships(TeamMembership(USER_ID, tenant_id, role))
    return TeamJwtAuthAdapter(verifier, memberships, authorization=authorization), memberships


async def test_team_owner_uses_signed_claim_and_server_membership_not_spoofed_header(
    signing_keys: tuple[Any, Any],
) -> None:
    private_key, public_key = signing_keys
    adapter, memberships = team_adapter(public_key, TeamBillingRole.VIEWER)
    token = token_for(private_key, claims={"tenant_id": str(TENANT_A)})

    identity = await adapter.authenticate(
        request_for(
            f"Bearer {token}",
            extra_headers=((b"x-tenant-id", str(TENANT_B).encode("ascii")),),
        )
    )

    assert identity.external_ref == f"v1:tenant:{TENANT_A}"
    assert memberships.queries == [(USER_ID, TENANT_A)]


async def test_team_membership_lookup_accepts_opaque_user_and_tenant_subjects(
    signing_keys: tuple[Any, Any],
) -> None:
    private_key, public_key = signing_keys
    opaque_subject = "auth0|team-user-123"
    opaque_tenant = "org_provider_123"
    verifier, _ = verifier_for(public_key)
    memberships = MemoryMemberships(
        TeamMembership(opaque_subject, opaque_tenant, TeamBillingRole.VIEWER)
    )
    adapter = TeamJwtAuthAdapter(verifier, memberships)
    token = token_for(
        private_key,
        claims={"sub": opaque_subject, "tenant_id": opaque_tenant},
    )

    identity = await adapter.authenticate(request_for(f"Bearer {token}"))

    assert identity.external_ref == f"v1:tenant:{opaque_tenant}"
    assert memberships.queries == [(opaque_subject, opaque_tenant)]


@pytest.mark.parametrize(
    "tenant_id",
    [
        str(TENANT_A).upper(),
        "00000000-0000-0000-0000-000000000000",
    ],
)
async def test_team_membership_preserves_uuid_like_opaque_tenant_exactly(
    tenant_id: str,
    signing_keys: tuple[Any, Any],
) -> None:
    private_key, public_key = signing_keys
    verifier, _ = verifier_for(public_key)
    memberships = MemoryMemberships(TeamMembership(USER_ID, tenant_id, TeamBillingRole.VIEWER))
    adapter = TeamJwtAuthAdapter(verifier, memberships)
    token = token_for(private_key, claims={"tenant_id": tenant_id})

    identity = await adapter.authenticate(request_for(f"Bearer {token}"))

    assert identity.external_ref == f"v1:tenant:{tenant_id}"
    assert memberships.queries == [(USER_ID, tenant_id)]


async def test_team_tenant_bound_includes_the_owner_reference_prefix(
    signing_keys: tuple[Any, Any],
) -> None:
    private_key, public_key = signing_keys
    accepted = "t" * 502
    rejected = "t" * 503
    verifier, _ = verifier_for(public_key)
    memberships = MemoryMemberships(TeamMembership(USER_ID, accepted, TeamBillingRole.VIEWER))
    adapter = TeamJwtAuthAdapter(verifier, memberships)

    identity = await adapter.authenticate(
        request_for(f"Bearer {token_for(private_key, claims={'tenant_id': accepted})}")
    )
    with pytest.raises(AuthenticationError, match="invalid bearer token"):
        await adapter.authenticate(
            request_for(f"Bearer {token_for(private_key, claims={'tenant_id': rejected})}")
        )

    assert len(identity.external_ref.encode("utf-8")) == 512
    assert memberships.queries == [(USER_ID, accepted)]


@pytest.mark.parametrize(
    "prefix",
    ["stripe", "/stripe/", "/stripe//billing", "/stripe?x=1", "/stripe#x", "/{tenant}"],
)
def test_team_policy_rejects_ambiguous_billing_prefix(prefix: str) -> None:
    with pytest.raises(ValueError, match="billing prefix"):
        TeamBillingAuthorizationPolicy(billing_prefix=prefix)


@pytest.mark.parametrize(
    ("method", "path", "capability"),
    [
        ("GET", "/api/catalog", TeamBillingCapability.CATALOG_READ),
        ("GET", "/api/account", TeamBillingCapability.ACCOUNT_READ),
        ("POST", "/api/checkout", TeamBillingCapability.CHECKOUT_CREATE),
        (
            "POST",
            "/api/credit-packs/checkout",
            TeamBillingCapability.CREDIT_PACK_CHECKOUT_CREATE,
        ),
        ("POST", "/api/billing/portal", TeamBillingCapability.PORTAL_OPEN),
        ("POST", "/api/billing/change/preview", TeamBillingCapability.PLAN_CHANGE),
        ("POST", "/api/billing/change/confirm", TeamBillingCapability.PLAN_CHANGE),
    ],
)
def test_team_policy_maps_each_public_billing_capability(
    method: str,
    path: str,
    capability: TeamBillingCapability,
) -> None:
    policy = TeamBillingAuthorizationPolicy()

    assert policy.capability_for(request_for("", method=method, path=path)) == capability


async def test_team_policy_requires_the_explicit_prefix_without_path_guessing(
    signing_keys: tuple[Any, Any],
) -> None:
    private_key, public_key = signing_keys
    policy = TeamBillingAuthorizationPolicy(billing_prefix="/stripe")
    adapter, _ = team_adapter(
        public_key,
        TeamBillingRole.VIEWER,
        authorization=policy,
    )
    token = token_for(private_key, claims={"tenant_id": str(TENANT_A)})

    identity = await adapter.authenticate(
        request_for(f"Bearer {token}", path="/stripe/api/catalog")
    )
    with pytest.raises(HTTPException) as unprefixed:
        await adapter.authenticate(request_for(f"Bearer {token}", path="/api/catalog"))

    assert identity.external_ref == f"v1:tenant:{TENANT_A}"
    assert unprefixed.value.status_code == 403


async def test_team_policy_matches_route_path_beneath_asgi_root_path(
    signing_keys: tuple[Any, Any],
) -> None:
    private_key, public_key = signing_keys
    policy = TeamBillingAuthorizationPolicy(billing_prefix="/stripe")
    adapter, _ = team_adapter(
        public_key,
        TeamBillingRole.VIEWER,
        authorization=policy,
    )
    token = token_for(private_key, claims={"tenant_id": str(TENANT_A)})

    identity = await adapter.authenticate(
        request_for(
            f"Bearer {token}",
            path="/edge/stripe/api/catalog",
            root_path="/edge",
        )
    )

    assert identity.external_ref == f"v1:tenant:{TENANT_A}"


async def test_signed_tenant_selector_without_current_membership_is_forbidden(
    signing_keys: tuple[Any, Any],
) -> None:
    private_key, public_key = signing_keys
    adapter, memberships = team_adapter(public_key, TeamBillingRole.VIEWER)
    token = token_for(private_key, claims={"tenant_id": str(TENANT_B)})

    with pytest.raises(HTTPException) as caught:
        await adapter.authenticate(request_for(f"Bearer {token}"))

    assert caught.value.status_code == 403
    assert memberships.queries == [(USER_ID, TENANT_B)]


@pytest.mark.parametrize(
    ("method", "path", "allowed"),
    [
        ("GET", "/api/catalog", True),
        ("GET", "/billing/catalog", True),
        ("GET", "/api/account", False),
        ("GET", "/billing/account", False),
        ("POST", "/api/checkout", False),
        ("POST", "/api/credit-packs/checkout", False),
        ("POST", "/api/billing/portal", False),
        ("POST", "/api/billing/change/preview", False),
        ("POST", "/api/billing/change/confirm", False),
        ("GET", "/host/new-billing-route", False),
    ],
)
async def test_team_viewer_route_matrix_fails_closed(
    signing_keys: tuple[Any, Any], method: str, path: str, allowed: bool
) -> None:
    private_key, public_key = signing_keys
    adapter, _ = team_adapter(public_key, TeamBillingRole.VIEWER)
    token = token_for(private_key, claims={"tenant_id": str(TENANT_A)})
    request = request_for(f"Bearer {token}", method=method, path=path)

    if allowed:
        identity = await adapter.authenticate(request)
        assert identity.external_ref == f"v1:tenant:{TENANT_A}"
    else:
        with pytest.raises(HTTPException) as caught:
            await adapter.authenticate(request)
        assert caught.value.status_code == 403


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", "/api/catalog"),
        ("GET", "/api/account"),
        ("POST", "/api/checkout"),
        ("POST", "/api/credit-packs/checkout"),
        ("POST", "/api/billing/portal"),
        ("POST", "/api/billing/change/preview"),
        ("POST", "/api/billing/change/confirm"),
    ],
)
async def test_team_billing_admin_can_use_each_billing_capability(
    signing_keys: tuple[Any, Any], method: str, path: str
) -> None:
    private_key, public_key = signing_keys
    adapter, _ = team_adapter(public_key, TeamBillingRole.BILLING_ADMIN)
    token = token_for(private_key, claims={"tenant_id": str(TENANT_A)})

    identity = await adapter.authenticate(request_for(f"Bearer {token}", method=method, path=path))

    assert identity.external_ref == f"v1:tenant:{TENANT_A}"


@pytest.mark.parametrize(
    "tenant_claim",
    [None, "", " org_provider_123", "org\nprovider", [str(TENANT_A)]],
)
async def test_team_tenant_claim_must_be_a_bounded_visible_string(
    signing_keys: tuple[Any, Any], tenant_claim: object
) -> None:
    private_key, public_key = signing_keys
    adapter, memberships = team_adapter(public_key, TeamBillingRole.VIEWER)
    claims = {} if tenant_claim is None else {"tenant_id": tenant_claim}
    token = token_for(private_key, claims=claims)

    with pytest.raises(AuthenticationError, match="invalid bearer token"):
        await adapter.authenticate(request_for(f"Bearer {token}"))
    assert memberships.queries == []


class MismatchedMemberships:
    async def membership_for(self, user_id: UUID | str, tenant_id: UUID | str) -> TeamMembership:
        return TeamMembership(user_id, TENANT_B, TeamBillingRole.BILLING_ADMIN)


async def test_repository_cannot_return_authority_for_another_tenant(
    signing_keys: tuple[Any, Any],
) -> None:
    private_key, public_key = signing_keys
    verifier, _ = verifier_for(public_key)
    adapter = TeamJwtAuthAdapter(verifier, MismatchedMemberships())
    token = token_for(private_key, claims={"tenant_id": str(TENANT_A)})

    with pytest.raises(RuntimeError, match="mismatched identity"):
        await adapter.authenticate(request_for(f"Bearer {token}"))


class PrefixTestGateway:
    secret_key = "sk_test_prefixed_auth_gateway"
    api_version = "2026-06-24.dahlia"
    product_line = "example-entitlements"
    checkout_success_url = "http://localhost:3000/billing/success"
    checkout_cancel_url = "http://localhost:3000/pricing"
    portal_return_url = "http://localhost:3000/account"
    portal_configuration_id = None

    def construct_event(self, payload: bytes, signature: str) -> dict[str, object]:
        del payload, signature
        raise ValueError("invalid signature")


def prefixed_settings() -> Settings:
    return Settings(
        database_url=TEST_DSN,
        stripe_secret_key="sk_test_prefixed_auth_settings",
        stripe_webhook_secret="whsec_prefixed_auth_test",
        stripe_webhook_api_version="2026-06-24.dahlia",
        plan_catalog_path=str(Path(__file__).parents[1] / "plans.toml"),
    )


async def test_real_prefixed_router_enforces_viewer_and_billing_admin_matrix(
    signing_keys: tuple[Any, Any], postgres_container: None
) -> None:
    del postgres_container
    private_key, public_key = signing_keys
    verifier, _ = verifier_for(public_key)
    memberships = MemoryMemberships(
        TeamMembership(USER_ID, TENANT_A, TeamBillingRole.VIEWER),
        TeamMembership(ADMIN_USER_ID, TENANT_A, TeamBillingRole.BILLING_ADMIN),
    )
    adapter = TeamJwtAuthAdapter(
        verifier,
        memberships,
        authorization=TeamBillingAuthorizationPolicy(billing_prefix="/stripe"),
    )
    kernel = BillingKernel(
        prefixed_settings(),
        database=Database(TEST_DSN),
        gateway=PrefixTestGateway(),  # type: ignore[arg-type]
        auth_adapter=adapter,
    )
    app = FastAPI()
    install_billing(app, kernel, prefix="/stripe")
    viewer_token = token_for(
        private_key,
        claims={"sub": str(USER_ID), "tenant_id": str(TENANT_A)},
    )
    admin_token = token_for(
        private_key,
        claims={"sub": str(ADMIN_USER_ID), "tenant_id": str(TENANT_A)},
    )
    protected_requests: list[tuple[str, str, dict[str, object] | None]] = [
        ("GET", "/stripe/api/account", None),
        (
            "POST",
            "/stripe/api/checkout",
            {
                "plan_key": "starter",
                "interval": "month",
                "success_url": "http://localhost:3000/billing/success",
                "cancel_url": "http://localhost:3000/pricing",
            },
        ),
        (
            "POST",
            "/stripe/api/credit-packs/checkout",
            {
                "pack_key": "boost_500",
                "success_url": "http://localhost:3000/billing/success",
                "cancel_url": "http://localhost:3000/pricing",
            },
        ),
        (
            "POST",
            "/stripe/api/billing/portal",
            {"return_url": "http://localhost:3000/account"},
        ),
        (
            "POST",
            "/stripe/api/billing/change/preview",
            {"plan_key": "starter", "interval": "month"},
        ),
        (
            "POST",
            "/stripe/api/billing/change/confirm",
            {"preview_id": str(uuid4())},
        ),
    ]
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(
            transport=transport, base_url="https://billing.example.test"
        ) as client:
            viewer_catalog = await client.get(
                "/stripe/api/catalog",
                headers={"Authorization": f"Bearer {viewer_token}"},
            )
            admin_catalog = await client.get(
                "/stripe/api/catalog",
                headers={"Authorization": f"Bearer {admin_token}"},
            )
            for method, path, body in protected_requests:
                viewer = await client.request(
                    method,
                    path,
                    headers={
                        "Authorization": f"Bearer {viewer_token}",
                        "Idempotency-Key": f"viewer-{path}",
                    },
                    json=body,
                )
                admin = await client.request(
                    method,
                    path,
                    headers={
                        "Authorization": f"Bearer {admin_token}",
                        "Idempotency-Key": f"admin-{path}",
                    },
                    json=body,
                )
                assert viewer.status_code == 403, (path, viewer.text)
                assert admin.status_code not in {401, 403, 404, 422}, (path, admin.text)

    assert viewer_catalog.status_code == 200
    assert admin_catalog.status_code == 200


async def test_example_postgres_membership_schema_and_repository_run_against_host_database(
    pool: asyncpg.Pool,
) -> None:
    opaque_subject = "auth0|Database-User-123"
    opaque_tenant = "org_Database_123"
    schema = (
        Path(__file__).parents[1] / "examples" / "auth_starters" / "team_schema.sql"
    ).read_text(encoding="utf-8")
    async with pool.acquire() as connection:
        await connection.execute(schema)
        await connection.executemany(
            "insert into app_users(id) values($1)",
            [(str(USER_ID),), (opaque_subject,)],
        )
        await connection.executemany(
            "insert into app_tenants(id) values($1)",
            [(str(TENANT_A),), (opaque_tenant,)],
        )
        await connection.executemany(
            """insert into app_team_memberships(user_id,tenant_id,billing_role)
               values($1,$2,'billing_admin')""",
            [
                (str(USER_ID), str(TENANT_A)),
                (opaque_subject, opaque_tenant),
            ],
        )
    database = Database(TEST_DSN)
    database.pool = pool
    repository = PostgresTeamMembershipRepository(database)
    try:
        membership = await repository.membership_for(USER_ID, TENANT_A)
        opaque_membership = await repository.membership_for(
            opaque_subject,
            opaque_tenant,
        )
        wrong_case = await repository.membership_for(
            opaque_subject.lower(),
            opaque_tenant.lower(),
        )
        missing = await repository.membership_for(USER_ID, TENANT_B)
        assert membership == TeamMembership(USER_ID, TENANT_A, TeamBillingRole.BILLING_ADMIN)
        assert opaque_membership == TeamMembership(
            opaque_subject,
            opaque_tenant,
            TeamBillingRole.BILLING_ADMIN,
        )
        assert wrong_case is None
        assert missing is None
    finally:
        async with pool.acquire() as connection:
            await connection.execute("drop table app_team_memberships, app_tenants, app_users")


@pytest.mark.parametrize("app_factory", [create_personal_app, create_team_app])
async def test_example_app_factory_enters_real_lifespan_and_serves_health(
    app_factory: Any, monkeypatch: pytest.MonkeyPatch, postgres_container: None
) -> None:
    del postgres_container
    environment = {
        "DATABASE_URL": TEST_DSN,
        "STRIPE_SECRET_KEY": "sk_test_auth_starter_placeholder",
        "STRIPE_WEBHOOK_SECRET": "whsec_auth_starter_placeholder",
        "STRIPE_WEBHOOK_API_VERSION": "2026-06-24.dahlia",
        "AUTH_JWT_ISSUER": ISSUER,
        "AUTH_JWT_AUDIENCE": AUDIENCE,
        "AUTH_JWKS_URL": "https://identity.example.test/.well-known/jwks.json",
        "AUTH_JWT_ALGORITHMS": "RS256",
        "APP_ENV": "production",
    }
    for name, value in environment.items():
        monkeypatch.setenv(name, value)
    get_settings.cache_clear()
    try:
        app = app_factory()
        async with app.router.lifespan_context(app):
            transport = httpx.ASGITransport(app=app)
            async with httpx.AsyncClient(
                transport=transport, base_url="https://billing.example.test"
            ) as client:
                response = await client.get("/health")
        assert response.status_code == 200
        assert response.json()["ok"] is True
        assert response.json()["database"] is True
    finally:
        get_settings.cache_clear()
