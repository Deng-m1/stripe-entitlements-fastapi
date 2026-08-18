from __future__ import annotations

from types import SimpleNamespace

import pytest

from stripe_entitlements.auth import AuthenticationError, DemoBearerAuthAdapter


@pytest.mark.parametrize(
    ("token", "subject", "email"),
    [
        ("", "subject", None),
        (" padded ", "subject", None),
        ("delete\x7f", "subject", None),
        ("zero\u200bwidth", "subject", None),
        ("🔐", "subject", None),
        ("token", "", None),
        ("token", " padded ", None),
        ("token", "subject", " bad@example.test "),
        ("token", "subject", "bad\x7f@example.test"),
    ],
)
def test_demo_auth_rejects_ambiguous_configuration(
    token: str, subject: str, email: str | None
) -> None:
    with pytest.raises(ValueError):
        DemoBearerAuthAdapter(token, subject, email)


async def test_demo_auth_compares_ascii_bearer_token_and_returns_stable_identity() -> None:
    adapter = DemoBearerAuthAdapter("local-secret-token", "demo-subject", "demo@example.test")
    request = SimpleNamespace(headers={"Authorization": "Bearer local-secret-token"})
    identity = await adapter.authenticate(request)  # type: ignore[arg-type]
    assert identity.external_ref == "demo-subject"
    assert identity.email == "demo@example.test"


@pytest.mark.parametrize(
    "authorization",
    [
        "",
        "Basic local-secret-token",
        "Bearer",
        "Bearer wrong-token",
        "Bearer local-secret-token extra",
    ],
)
async def test_demo_auth_rejects_invalid_authorization_without_partial_matching(
    authorization: str,
) -> None:
    adapter = DemoBearerAuthAdapter("local-secret-token", "demo-subject")
    request = SimpleNamespace(headers={"Authorization": authorization})
    with pytest.raises(AuthenticationError, match="invalid bearer token"):
        await adapter.authenticate(request)  # type: ignore[arg-type]
