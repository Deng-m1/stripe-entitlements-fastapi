from __future__ import annotations

from types import SimpleNamespace

import pytest

from stripe_entitlements.internal_auth import (
    RejectAllWorkloadIdentityAdapter,
    WorkloadAuthenticationError,
    WorkloadPrincipal,
)


def test_workload_principal_requires_bounded_verified_identity_and_scopes() -> None:
    principal = WorkloadPrincipal(
        issuer="https://identity.example.test",
        subject="product-worker",
        scopes=frozenset({"entitlements:check", "credits:charge"}),
    )
    assert principal.subject == "product-worker"
    with pytest.raises(ValueError, match="issuer"):
        WorkloadPrincipal(" padded ", "worker", frozenset())
    with pytest.raises(ValueError, match="scopes"):
        WorkloadPrincipal("issuer", "worker", frozenset({"INVALID SCOPE"}))
    with pytest.raises(ValueError, match="frozenset"):
        WorkloadPrincipal("issuer", "worker", {"credits:charge"})  # type: ignore[arg-type]


async def test_default_workload_adapter_rejects_every_request() -> None:
    adapter = RejectAllWorkloadIdentityAdapter()
    with pytest.raises(WorkloadAuthenticationError):
        await adapter.authenticate(SimpleNamespace())  # type: ignore[arg-type]
