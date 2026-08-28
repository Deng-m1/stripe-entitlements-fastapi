from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import asyncpg
import httpx
import pytest
from fastapi import FastAPI

from stripe_entitlements.catalog import PlanCatalog
from stripe_entitlements.entitlements import EntitlementService
from stripe_entitlements.internal_api import (
    CREDITS_CHARGE_SCOPE,
    CREDITS_REFUND_SCOPE,
    ENTITLEMENTS_CHECK_SCOPE,
    create_internal_router,
)
from stripe_entitlements.internal_auth import (
    WorkloadAuthenticationError,
    WorkloadAuthorizationError,
    WorkloadPrincipal,
)
from stripe_entitlements.processor import EventProcessor
from tests.builders import paid_invoice


class StaticWorkloadAuth:
    def __init__(self, *scopes: str) -> None:
        self.principal = WorkloadPrincipal(
            issuer="https://workload.example.test",
            subject="product-api",
            scopes=frozenset(scopes),
        )

    async def authenticate(self, request):  # type: ignore[no-untyped-def]
        del request
        return self.principal


class SecretRejectingWorkloadAuth:
    async def authenticate(self, request):  # type: ignore[no-untyped-def]
        del request
        raise WorkloadAuthenticationError("expired-or-replayed-token secret-token-body")


class ClaimCheckingWorkloadAuth:
    """Host-side example proving the adapter owns JWT claim/replay verification."""

    def __init__(
        self,
        *,
        issuer: str = "https://trusted-issuer.example.test",
        audience: str = "stripe-entitlements-internal",
        expires_at: datetime | None = None,
    ) -> None:
        self.issuer = issuer
        self.audience = audience
        self.expires_at = expires_at or datetime.now(UTC) + timedelta(minutes=5)
        self.seen_credentials: set[str] = set()

    async def authenticate(self, request):  # type: ignore[no-untyped-def]
        credential = request.headers.get("Authorization", "")
        if self.issuer != "https://trusted-issuer.example.test":
            raise WorkloadAuthenticationError("untrusted issuer private claim")
        if self.audience != "stripe-entitlements-internal":
            raise WorkloadAuthenticationError("wrong audience private claim")
        if self.expires_at <= datetime.now(UTC):
            raise WorkloadAuthenticationError("expired credential private claim")
        if credential in self.seen_credentials:
            raise WorkloadAuthenticationError("replayed credential private claim")
        self.seen_credentials.add(credential)
        return WorkloadPrincipal(
            issuer=self.issuer,
            subject="claim-checked-worker",
            scopes=frozenset({ENTITLEMENTS_CHECK_SCOPE}),
        )


class BoundOwnerAuthorizer:
    def __init__(self, *owners: str) -> None:
        self.owners = frozenset(owners)

    async def authorize(
        self,
        principal: WorkloadPrincipal,
        owner_external_ref: str,
        required_scope: str,
    ) -> None:
        del principal, required_scope
        if owner_external_ref not in self.owners:
            raise WorkloadAuthorizationError("host membership denied with private detail")


def _app(
    service: EntitlementService,
    auth: StaticWorkloadAuth | SecretRejectingWorkloadAuth | ClaimCheckingWorkloadAuth | None,
    *owners: str,
) -> FastAPI:
    app = FastAPI()
    kwargs = {"service_provider": lambda: service}
    if auth is not None:
        kwargs["auth_adapter"] = auth  # type: ignore[assignment]
    if owners:
        kwargs["owner_authorizer"] = BoundOwnerAuthorizer(*owners)  # type: ignore[assignment]
    app.include_router(create_internal_router(**kwargs))  # type: ignore[arg-type]
    return app


async def _request(app: FastAPI, method: str, path: str, **kwargs):  # type: ignore[no-untyped-def]
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://internal.test",
    ) as client:
        return await client.request(method, path, **kwargs)


async def test_internal_router_defaults_to_reject_all_and_sanitizes_auth_failure(
    pool: asyncpg.Pool, catalog: PlanCatalog
) -> None:
    service = EntitlementService(pool, catalog)
    default_response = await _request(
        _app(service, None),
        "POST",
        "/internal/v1/entitlements/check",
        json={"owner_external_ref": f"v1:user:{uuid.uuid4()}"},
    )
    expired_response = await _request(
        _app(service, SecretRejectingWorkloadAuth()),
        "POST",
        "/internal/v1/entitlements/check",
        json={"owner_external_ref": f"v1:user:{uuid.uuid4()}"},
    )

    assert default_response.status_code == 401
    assert expired_response.status_code == 401
    assert default_response.headers["cache-control"] == "no-store"
    assert expired_response.headers["cache-control"] == "no-store"
    assert default_response.json() == {"detail": "workload authentication failed"}
    assert expired_response.json() == {"detail": "workload authentication failed"}
    assert "secret-token-body" not in expired_response.text


async def test_internal_scopes_are_capability_specific(
    pool: asyncpg.Pool, catalog: PlanCatalog
) -> None:
    service = EntitlementService(pool, catalog)
    owner = f"v1:user:{uuid.uuid4()}"
    app = _app(service, StaticWorkloadAuth(ENTITLEMENTS_CHECK_SCOPE), owner)

    check = await _request(
        app,
        "POST",
        "/internal/v1/entitlements/check",
        json={"owner_external_ref": owner},
    )
    charge = await _request(
        app,
        "POST",
        "/internal/v1/credits/charge",
        headers={"Idempotency-Key": "scope-denied"},
        json={"owner_external_ref": owner, "amount": "1"},
    )

    assert check.status_code == 200
    assert charge.status_code == 403
    assert charge.json() == {"detail": "workload is not authorized"}


async def test_configured_identity_without_owner_authorizer_still_fails_closed(
    pool: asyncpg.Pool, catalog: PlanCatalog
) -> None:
    owner = f"v1:tenant:{uuid.uuid4()}"
    response = await _request(
        _app(
            EntitlementService(pool, catalog),
            StaticWorkloadAuth(ENTITLEMENTS_CHECK_SCOPE),
        ),
        "POST",
        "/internal/v1/entitlements/check",
        json={"owner_external_ref": owner},
    )
    assert response.status_code == 403
    assert response.headers["cache-control"] == "no-store"
    assert response.json() == {"detail": "workload is not authorized"}


async def test_owner_authorizer_rejects_cross_tenant_before_service_lookup(
    pool: asyncpg.Pool, catalog: PlanCatalog
) -> None:
    permitted_owner = f"v1:tenant:{uuid.uuid4()}"
    other_owner = f"v1:tenant:{uuid.uuid4()}"
    response = await _request(
        _app(
            EntitlementService(pool, catalog),
            StaticWorkloadAuth(ENTITLEMENTS_CHECK_SCOPE),
            permitted_owner,
        ),
        "POST",
        "/internal/v1/entitlements/check",
        json={"owner_external_ref": other_owner},
    )
    assert response.status_code == 403
    assert response.json() == {"detail": "workload is not authorized"}
    assert "membership denied" not in response.text


@pytest.mark.parametrize(
    "adapter",
    [
        ClaimCheckingWorkloadAuth(issuer="https://attacker.example.test"),
        ClaimCheckingWorkloadAuth(audience="another-service"),
        ClaimCheckingWorkloadAuth(expires_at=datetime.now(UTC) - timedelta(seconds=1)),
    ],
)
async def test_host_adapter_rejects_issuer_audience_and_expiry_without_leaking_claims(
    adapter: ClaimCheckingWorkloadAuth,
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
) -> None:
    owner = f"v1:tenant:{uuid.uuid4()}"
    response = await _request(
        _app(EntitlementService(pool, catalog), adapter, owner),
        "POST",
        "/internal/v1/entitlements/check",
        headers={"Authorization": "Bearer private-credential"},
        json={"owner_external_ref": owner},
    )
    assert response.status_code == 401
    assert response.json() == {"detail": "workload authentication failed"}
    assert "private claim" not in response.text


async def test_host_adapter_can_reject_a_replayed_workload_credential(
    pool: asyncpg.Pool, catalog: PlanCatalog
) -> None:
    owner = f"v1:tenant:{uuid.uuid4()}"
    app = _app(EntitlementService(pool, catalog), ClaimCheckingWorkloadAuth(), owner)
    request = {
        "method": "POST",
        "path": "/internal/v1/entitlements/check",
        "headers": {"Authorization": "Bearer one-use-proof"},
        "json": {"owner_external_ref": owner},
    }
    first = await _request(app, **request)
    replay = await _request(app, **request)

    assert first.status_code == 200
    assert replay.status_code == 401
    assert replay.json() == {"detail": "workload authentication failed"}


async def test_check_response_is_sanitized_and_decides_feature_and_limit(
    processor: EventProcessor,
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    make_account,
) -> None:
    owner = f"v1:tenant:{uuid.uuid4()}"
    account_id = await make_account(external_ref=owner)
    await processor.process(paid_invoice(account_id))
    app = _app(
        EntitlementService(pool, catalog),
        StaticWorkloadAuth(ENTITLEMENTS_CHECK_SCOPE),
        owner,
    )

    response = await _request(
        app,
        "POST",
        "/internal/v1/entitlements/check",
        json={
            "owner_external_ref": owner,
            "required_features": ["pdf_to_ppt"],
            "required_limits": {"max_file_mb": 30},
        },
    )
    payload = response.json()

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert payload["allowed"] is True
    assert payload["features"] == {"pdf_to_ppt": True}
    assert payload["limits"]["max_file_mb"] == {
        "requested": 30,
        "maximum": 30,
        "allowed": True,
    }
    assert payload["credits"]["balance"] == "300"
    assert payload["credits"]["spendable"] is True
    assert payload["credits"]["expires_at"] is not None
    assert not {
        "account_id",
        "stripe_customer_id",
        "stripe_subscription_id",
        "pending_change",
        "payment_url",
        "recovery_url",
    }.intersection(payload)
    assert "payment_url" not in response.text
    assert "recovery_url" not in response.text


@pytest.mark.parametrize(
    "extra",
    [
        {"account_id": "00000000-0000-4000-8000-000000000001"},
        {"stripe_customer_id": "cus_attacker"},
        {"stripe_subscription_id": "sub_attacker"},
    ],
)
async def test_internal_requests_never_accept_infrastructure_selectors(
    extra: dict[str, str], pool: asyncpg.Pool, catalog: PlanCatalog
) -> None:
    owner = f"v1:user:{uuid.uuid4()}"
    body = {"owner_external_ref": owner, **extra}
    response = await _request(
        _app(
            EntitlementService(pool, catalog),
            StaticWorkloadAuth(ENTITLEMENTS_CHECK_SCOPE),
            owner,
        ),
        "POST",
        "/internal/v1/entitlements/check",
        json=body,
    )
    assert response.status_code == 422


@pytest.mark.parametrize(
    "owner_selector",
    [
        "acct_test_owner",
        "cus_test_owner",
        "sub_test_owner",
        "00000000-0000-4000-8000-000000000001",
        "00000000000040008000000000000001",
    ],
)
async def test_owner_external_ref_value_cannot_smuggle_infrastructure_id(
    owner_selector: str, pool: asyncpg.Pool, catalog: PlanCatalog
) -> None:
    response = await _request(
        _app(
            EntitlementService(pool, catalog),
            StaticWorkloadAuth(ENTITLEMENTS_CHECK_SCOPE),
            owner_selector,
        ),
        "POST",
        "/internal/v1/entitlements/check",
        json={"owner_external_ref": owner_selector},
    )
    assert response.status_code == 400
    assert response.json() == {"detail": "invalid owner reference"}


async def test_charge_requires_decimal_string_and_maps_replay_and_conflict(
    processor: EventProcessor,
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    make_account,
) -> None:
    owner = f"v1:user:{uuid.uuid4()}"
    account_id = await make_account(external_ref=owner)
    await processor.process(paid_invoice(account_id))
    app = _app(
        EntitlementService(pool, catalog),
        StaticWorkloadAuth(CREDITS_CHARGE_SCOPE),
        owner,
    )
    path = "/internal/v1/credits/charge"
    headers = {"Idempotency-Key": "api-product-job"}

    numeric = await _request(
        app,
        "POST",
        path,
        headers=headers,
        json={"owner_external_ref": owner, "amount": 0.1},
    )
    charged = await _request(
        app,
        "POST",
        path,
        headers=headers,
        json={"owner_external_ref": owner, "amount": "0.1"},
    )
    replay = await _request(
        app,
        "POST",
        path,
        headers=headers,
        json={"owner_external_ref": owner, "amount": "0.100000"},
    )
    conflict = await _request(
        app,
        "POST",
        path,
        headers=headers,
        json={"owner_external_ref": owner, "amount": "0.100001"},
    )

    assert numeric.status_code == 422
    assert charged.status_code == 200
    assert charged.json()["outcome"] == "charged"
    assert charged.json()["balance"] == "299.9"
    assert charged.json()["requested"] == "0.1"
    assert charged.json()["requested_atoms"] == "100000"
    assert charged.json()["restored"] == "0"
    assert charged.json()["restored_atoms"] == "0"
    assert replay.json()["outcome"] == "replayed"
    assert replay.json()["requested_atoms"] == "100000"
    assert replay.json()["restored_atoms"] == "0"
    assert conflict.status_code == 409
    assert conflict.json() == {"detail": "credit idempotency conflict"}


async def test_charge_maps_missing_insufficient_and_unavailable_without_internal_details(
    processor: EventProcessor,
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    make_account,
) -> None:
    owner = f"v1:user:{uuid.uuid4()}"
    missing_owner = f"v1:user:{uuid.uuid4()}"
    account_id = await make_account(external_ref=owner)
    await processor.process(paid_invoice(account_id))
    app = _app(
        EntitlementService(pool, catalog),
        StaticWorkloadAuth(CREDITS_CHARGE_SCOPE),
        owner,
        missing_owner,
    )
    path = "/internal/v1/credits/charge"

    missing = await _request(
        app,
        "POST",
        path,
        headers={"Idempotency-Key": "missing-owner-job"},
        json={"owner_external_ref": missing_owner, "amount": "1"},
    )
    insufficient = await _request(
        app,
        "POST",
        path,
        headers={"Idempotency-Key": "insufficient-owner-job"},
        json={"owner_external_ref": owner, "amount": "300.000001"},
    )
    async with pool.acquire() as conn:
        await conn.execute(
            "update billing_accounts set credit_expires_at=now()-interval '1 second' "
            "where id=$1::uuid",
            account_id,
        )
    unavailable = await _request(
        app,
        "POST",
        path,
        headers={"Idempotency-Key": "expired-owner-job"},
        json={"owner_external_ref": owner, "amount": "1"},
    )
    invalid_key = await _request(
        app,
        "POST",
        path,
        headers={"Idempotency-Key": " padded "},
        json={"owner_external_ref": owner, "amount": "1"},
    )

    assert missing.status_code == 404
    assert missing.json() == {"detail": "billing owner not found"}
    assert insufficient.status_code == 409
    assert insufficient.json() == {"detail": "insufficient credits"}
    assert unavailable.status_code == 409
    assert unavailable.json() == {"detail": "credits are unavailable"}
    assert invalid_key.status_code == 400
    assert invalid_key.json() == {"detail": "invalid credit charge request"}


async def test_refund_cannot_cross_owner_and_maps_unknown_key_identically(
    processor: EventProcessor,
    pool: asyncpg.Pool,
    catalog: PlanCatalog,
    make_account,
) -> None:
    first_owner = f"v1:tenant:{uuid.uuid4()}"
    second_owner = f"v1:tenant:{uuid.uuid4()}"
    first_id = await make_account(
        external_ref=first_owner,
        customer="cus_api_owner_first",
        subscription="sub_api_owner_first",
    )
    second_id = await make_account(
        external_ref=second_owner,
        customer="cus_api_owner_second",
        subscription="sub_api_owner_second",
    )
    await processor.process(
        paid_invoice(
            first_id,
            invoice_id="in_api_owner_first",
            customer="cus_api_owner_first",
            subscription="sub_api_owner_first",
        )
    )
    await processor.process(
        paid_invoice(
            second_id,
            invoice_id="in_api_owner_second",
            customer="cus_api_owner_second",
            subscription="sub_api_owner_second",
        )
    )
    service = EntitlementService(pool, catalog)
    await service.charge(first_owner, "10", "private-owner-job")
    app = _app(service, StaticWorkloadAuth(CREDITS_REFUND_SCOPE), first_owner, second_owner)
    path = "/internal/v1/credits/refund"

    cross_owner = await _request(
        app,
        "POST",
        path,
        headers={"Idempotency-Key": "private-owner-job"},
        json={"owner_external_ref": second_owner},
    )
    unknown = await _request(
        app,
        "POST",
        path,
        headers={"Idempotency-Key": "unknown-owner-job"},
        json={"owner_external_ref": second_owner},
    )
    legitimate = await _request(
        app,
        "POST",
        path,
        headers={"Idempotency-Key": "private-owner-job"},
        json={"owner_external_ref": first_owner},
    )
    legitimate_replay = await _request(
        app,
        "POST",
        path,
        headers={"Idempotency-Key": "private-owner-job"},
        json={"owner_external_ref": first_owner},
    )

    assert cross_owner.status_code == unknown.status_code == 404
    assert cross_owner.json() == unknown.json() == {"detail": "credit operation not found"}
    assert legitimate.status_code == 200
    assert legitimate.json()["outcome"] == "refunded"
    assert legitimate.json()["requested"] == "10"
    assert legitimate.json()["requested_atoms"] == "10000000"
    assert legitimate.json()["restored"] == "10"
    assert legitimate.json()["restored_atoms"] == "10000000"
    assert legitimate_replay.status_code == 200
    assert legitimate_replay.json()["outcome"] == "replayed"
    assert legitimate_replay.json()["requested_atoms"] == "10000000"
    assert legitimate_replay.json()["restored_atoms"] == "10000000"
