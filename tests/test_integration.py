from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
import pytest
from fastapi import APIRouter, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from stripe_entitlements import (
    BillingKernel,
    BillingServices,
    create_app,
    create_billing_router,
    install_billing,
)
from stripe_entitlements.auth import AuthenticatedIdentity
from stripe_entitlements.config import Settings
from stripe_entitlements.database import Database
from stripe_entitlements.internal_api import (
    CREDITS_REFUND_SCOPE,
    ENTITLEMENTS_CHECK_SCOPE,
    create_internal_router,
)
from stripe_entitlements.internal_auth import WorkloadPrincipal
from tests.conftest import TEST_DSN


class StaticAuth:
    async def authenticate(self, request):  # type: ignore[no-untyped-def]
        del request
        return AuthenticatedIdentity("integration-user", "integration@example.test")


class FakeGateway:
    secret_key = "sk_test_integration_gateway"

    def construct_event(self, payload: bytes, signature: str):  # type: ignore[no-untyped-def]
        del payload, signature
        raise ValueError("invalid signature")


class StaticWorkloadAuth:
    async def authenticate(self, request):  # type: ignore[no-untyped-def]
        del request
        return WorkloadPrincipal(
            issuer="integration-test",
            subject="product-api",
            scopes=frozenset({ENTITLEMENTS_CHECK_SCOPE, CREDITS_REFUND_SCOPE}),
        )


class AllowTestOwner:
    async def authorize(self, principal, owner_external_ref, required_scope):  # type: ignore[no-untyped-def]
        assert principal.subject == "product-api"
        assert owner_external_ref == "v1:user:missing"
        assert required_scope in {ENTITLEMENTS_CHECK_SCOPE, CREDITS_REFUND_SCOPE}


class CountingDatabase(Database):
    def __init__(self, dsn: str) -> None:
        super().__init__(dsn)
        self.connect_calls = 0
        self.close_calls = 0

    async def connect(self) -> None:
        self.connect_calls += 1
        await super().connect()

    async def close(self) -> None:
        self.close_calls += 1
        await super().close()


def _settings() -> Settings:
    return Settings(
        database_url=TEST_DSN,
        stripe_secret_key="sk_test_dummy",
        stripe_webhook_secret="whsec_integration_test",
        stripe_webhook_api_version="2026-06-24.dahlia",
        stripe_portal_configuration_id="bpc_test",
        plan_catalog_path=str(Path(__file__).parents[1] / "plans.toml"),
    )


def _kernel(database: Database | None = None) -> BillingKernel:
    return BillingKernel(
        _settings(),
        database=database or Database(TEST_DSN),
        gateway=FakeGateway(),  # type: ignore[arg-type]
        auth_adapter=StaticAuth(),
    )


def test_public_facade_builds_a_native_prefixed_router() -> None:
    kernel = _kernel()
    router = create_billing_router(kernel, prefix="/stripe")
    assert isinstance(router, APIRouter)
    paths = {route.path for route in router.routes}
    assert "/stripe/health" in paths
    assert "/stripe/api/account" in paths
    assert "/stripe/billing/account" in paths
    assert "/stripe/webhooks/stripe" in paths


def test_install_preserves_host_openapi_and_installs_internal_router() -> None:
    app = FastAPI(title="Host product")

    @app.get("/api/products")
    async def products() -> dict[str, list[object]]:
        return {"products": []}

    internal = APIRouter(prefix="/internal/v1")

    @internal.get("/probe")
    async def internal_probe() -> dict[str, bool]:
        return {"ok": True}

    installed = install_billing(
        app,
        _kernel(),
        prefix="/stripe",
        internal_routers=[internal],
    )
    assert isinstance(installed, APIRouter)
    schema_paths = set(app.openapi()["paths"])
    assert "/api/products" in schema_paths
    assert "/stripe/api/account" in schema_paths
    assert "/stripe/webhooks/stripe" in schema_paths
    assert "/stripe/internal/v1/probe" in schema_paths
    assert "/stripe/billing/account" not in schema_paths


async def test_install_composes_host_lifespan_and_reuses_its_pool(
    postgres_container: None,
) -> None:
    database = CountingDatabase(TEST_DSN)
    events: list[str] = []

    @asynccontextmanager
    async def host_lifespan(app: FastAPI) -> AsyncIterator[dict[str, bool]]:
        del app
        events.append("host.start")
        await database.connect()
        host_pool = database.require_pool()
        try:
            yield {"host_started": True}
        finally:
            events.append("host.stop")
            assert database.require_pool() is host_pool
            with pytest.raises(RuntimeError, match="inside the app lifespan"):
                kernel.require_services()
            await database.close()

    app = FastAPI(lifespan=host_lifespan)
    kernel = _kernel(database)
    install_billing(app, kernel, prefix="/stripe")

    async with app.router.lifespan_context(app) as state:
        assert state == {"host_started": True}
        assert isinstance(kernel.require_services(), BillingServices)
        assert kernel.database.require_pool() is database.require_pool()
        assert app.state.stripe_entitlements is kernel
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            health = await client.get("/stripe/health")
        assert health.status_code == 200

    assert events == ["host.start", "host.stop"]
    assert database.connect_calls == 1
    assert database.close_calls == 1
    assert database.pool is None


async def test_public_install_does_not_configure_host_logging(
    postgres_container: None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[dict[str, object]] = []
    monkeypatch.setattr(
        "stripe_entitlements.kernel.logging.basicConfig",
        lambda **kwargs: calls.append(kwargs),
    )

    embedded = FastAPI()
    install_billing(embedded, _kernel(), prefix="/stripe")
    async with embedded.router.lifespan_context(embedded):
        assert calls == []

    standalone = create_app(
        _settings(),
        database=Database(TEST_DSN),
        gateway=FakeGateway(),  # type: ignore[arg-type]
        auth_adapter=StaticAuth(),
    )
    async with standalone.router.lifespan_context(standalone):
        assert calls == [{"level": "INFO"}]


async def test_scoped_middleware_does_not_change_host_routes_or_webhook_guard(
    postgres_container: None,
) -> None:
    app = FastAPI()

    @app.post("/api/host-operation")
    async def host_operation() -> dict[str, bool]:
        return {"host": True}

    install_billing(app, _kernel(), prefix="/stripe")
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            host = await client.post(
                "/api/host-operation", headers={"Origin": "https://attacker.example"}
            )
            rejected = await client.post(
                "/stripe/api/checkout", headers={"Origin": "https://attacker.example"}
            )
            preflight = await client.options(
                "/stripe/api/checkout",
                headers={
                    "Origin": "http://localhost:3000",
                    "Access-Control-Request-Method": "POST",
                    "Access-Control-Request-Headers": "Authorization,Idempotency-Key",
                },
            )
            webhook = await client.post(
                "/stripe/webhooks/stripe",
                headers={
                    "Origin": "https://attacker.example",
                    "Stripe-Signature": "invalid",
                },
                content=b"{}",
            )

    assert host.status_code == 200
    assert "cache-control" not in host.headers
    assert "access-control-allow-origin" not in host.headers
    assert rejected.status_code == 403
    assert rejected.json() == {"error": "request origin is not allowed"}
    assert rejected.headers["cache-control"] == "no-store"
    assert rejected.headers["pragma"] == "no-cache"
    assert rejected.headers["x-content-type-options"] == "nosniff"
    assert preflight.status_code == 200
    assert preflight.headers["access-control-allow-origin"] == "http://localhost:3000"
    assert webhook.status_code == 400
    assert webhook.json() == {"error": "invalid Stripe signature"}
    assert webhook.headers["cache-control"] == "no-store"


async def test_mounted_billing_uses_route_path_for_origin_guard_and_hardening() -> None:
    billing_app = FastAPI()
    install_billing(billing_app, _kernel(), prefix="/stripe")
    host_app = FastAPI()
    host_app.mount("/edge", billing_app)

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=host_app), base_url="http://test"
    ) as client:
        catalog = await client.get(
            "/edge/stripe/api/catalog",
            headers={"Origin": "http://localhost:3000"},
        )
        rejected = await client.post(
            "/edge/stripe/api/checkout",
            headers={"Origin": "https://attacker.example"},
            json={},
        )

    assert catalog.status_code == 200
    assert catalog.headers["cache-control"] == "no-store"
    assert catalog.headers["pragma"] == "no-cache"
    assert catalog.headers["x-content-type-options"] == "nosniff"
    assert catalog.headers["access-control-allow-origin"] == "http://localhost:3000"
    assert rejected.status_code == 403
    assert rejected.json() == {"error": "request origin is not allowed"}
    assert rejected.headers["cache-control"] == "no-store"
    assert rejected.headers["x-content-type-options"] == "nosniff"


async def test_internal_routes_strip_host_cors_without_changing_host_routes(
    postgres_container: None,
) -> None:
    del postgres_container
    app = FastAPI()

    @app.get("/api/products")
    async def products() -> dict[str, bool]:
        return {"ok": True}

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["https://frontend.example"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    kernel = _kernel()
    install_billing(
        app,
        kernel,
        prefix="/stripe",
        internal_routers=[
            create_internal_router(
                service_provider=lambda: kernel.require_services().entitlements,
            )
        ],
    )
    origin_headers = {"Origin": "https://frontend.example"}

    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            internal = await client.post(
                "/stripe/internal/v1/entitlements/check",
                headers=origin_headers,
                json={"owner_external_ref": "v1:user:missing"},
            )
            preflight = await client.options(
                "/stripe/internal/v1/entitlements/check",
                headers={
                    **origin_headers,
                    "Access-Control-Request-Method": "POST",
                    "Access-Control-Request-Headers": "Authorization,Content-Type",
                },
            )
            host = await client.get("/api/products", headers=origin_headers)

    for response in (internal, preflight):
        assert not any(name.startswith("access-control-") for name in response.headers)
        assert "origin" not in {
            token.strip().lower()
            for token in response.headers.get("vary", "").split(",")
            if token.strip()
        }
        assert response.headers["cache-control"] == "no-store"
        assert response.headers["x-content-type-options"] == "nosniff"
    assert internal.status_code == 401
    assert preflight.status_code == 200
    assert host.status_code == 200
    assert host.headers["access-control-allow-origin"] == "https://frontend.example"
    assert host.headers["access-control-allow-credentials"] == "true"
    assert "origin" in host.headers.get("vary", "").lower()


async def test_internal_startup_fails_if_host_cors_is_registered_outside_billing() -> None:
    app = FastAPI()
    kernel = _kernel()
    install_billing(
        app,
        kernel,
        prefix="/stripe",
        internal_routers=[
            create_internal_router(
                service_provider=lambda: kernel.require_services().entitlements,
            )
        ],
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["https://frontend.example"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    with pytest.raises(
        RuntimeError,
        match="register CORS first and call install_billing last",
    ):
        async with app.router.lifespan_context(app):
            pass


async def test_public_only_install_allows_host_cors_registered_after_billing(
    postgres_container: None,
) -> None:
    del postgres_container
    app = FastAPI()
    kernel = _kernel()
    install_billing(app, kernel, prefix="/stripe")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["https://frontend.example"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    async with app.router.lifespan_context(app):
        assert kernel.require_services() is not None


async def test_install_hook_initializes_internal_entitlement_router(
    postgres_container: None,
) -> None:
    app = FastAPI()
    kernel = _kernel()
    internal_router = create_internal_router(
        service_provider=lambda: kernel.require_services().entitlements,
        auth_adapter=StaticWorkloadAuth(),
        owner_authorizer=AllowTestOwner(),
    )
    install_billing(
        app,
        kernel,
        prefix="/stripe",
        internal_routers=[internal_router],
    )
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.post(
                "/stripe/internal/v1/entitlements/check",
                headers={"Origin": "http://localhost:3000"},
                json={
                    "owner_external_ref": "v1:user:missing",
                    "required_features": [],
                    "required_limits": {},
                },
            )
            invalid = await client.post(
                "/stripe/internal/v1/entitlements/check",
                headers={"Origin": "http://localhost:3000"},
                json={},
            )
            missing = await client.post(
                "/stripe/internal/v1/credits/refund",
                headers={
                    "Idempotency-Key": "missing-credit-operation",
                    "Origin": "http://localhost:3000",
                },
                json={"owner_external_ref": "v1:user:missing"},
            )
    assert response.status_code == 200
    assert response.json()["reason"] == "owner_not_found"
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["pragma"] == "no-cache"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert "access-control-allow-origin" not in response.headers
    assert invalid.status_code == 422
    assert invalid.headers["cache-control"] == "no-store"
    assert invalid.headers["x-content-type-options"] == "nosniff"
    assert "access-control-allow-origin" not in invalid.headers
    assert missing.status_code == 404
    assert missing.headers["cache-control"] == "no-store"
    assert missing.headers["x-content-type-options"] == "nosniff"
    assert "access-control-allow-origin" not in missing.headers


async def test_internal_router_keeps_hostile_browser_origin_out_of_public_cors(
    postgres_container: None,
) -> None:
    app = FastAPI()
    kernel = _kernel()
    internal_router = create_internal_router(
        service_provider=lambda: kernel.require_services().entitlements,
    )
    install_billing(
        app,
        kernel,
        prefix="/stripe",
        internal_routers=[internal_router],
    )

    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.post(
                "/stripe/internal/v1/entitlements/check",
                headers={"Origin": "https://attacker.example"},
                json={
                    "owner_external_ref": "v1:user:missing",
                    "required_features": [],
                    "required_limits": {},
                },
            )
            preflight = await client.options(
                "/stripe/internal/v1/entitlements/check",
                headers={
                    "Origin": "https://attacker.example",
                    "Access-Control-Request-Method": "POST",
                    "Access-Control-Request-Headers": "Authorization,Content-Type",
                },
            )

    assert response.status_code == 401
    assert response.json() == {"detail": "workload authentication failed"}
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert "access-control-allow-origin" not in response.headers
    assert "access-control-allow-credentials" not in response.headers
    assert preflight.status_code == 405
    assert preflight.headers["cache-control"] == "no-store"
    assert preflight.headers["x-content-type-options"] == "nosniff"
    assert "access-control-allow-origin" not in preflight.headers
    assert "access-control-allow-credentials" not in preflight.headers


def test_database_object_can_bind_to_only_one_kernel() -> None:
    database = Database(TEST_DSN)
    first = _kernel(database)

    with pytest.raises(RuntimeError, match="already bound to another BillingKernel"):
        _kernel(database)

    same_dsn_separate_owner = _kernel(Database(TEST_DSN))
    assert first.database is database
    assert same_dsn_separate_owner.database is not database


def test_install_rejects_duplicate_or_invalid_prefix_without_duplicate_routes() -> None:
    app = FastAPI()
    kernel = _kernel()
    install_billing(app, kernel)
    route_count = len(app.routes)
    with pytest.raises(RuntimeError, match="already installed"):
        install_billing(app, kernel)
    assert len(app.routes) == route_count

    with pytest.raises(ValueError, match="billing prefix"):
        create_billing_router(_kernel(), prefix="stripe/")


async def test_create_app_keeps_legacy_paths_and_state_aliases(
    postgres_container: None,
) -> None:
    app = create_app(
        _settings(),
        database=Database(TEST_DSN),
        gateway=FakeGateway(),  # type: ignore[arg-type]
        auth_adapter=StaticAuth(),
    )
    paths = set(app.openapi()["paths"])
    assert {
        "/health",
        "/api/catalog",
        "/api/account",
        "/api/checkout",
        "/api/billing/portal",
        "/api/billing/change/preview",
        "/api/billing/change/confirm",
        "/webhooks/stripe",
    }.issubset(paths)
    async with app.router.lifespan_context(app):
        assert app.state.database is app.state.billing_kernel.database
        assert app.state.processor is app.state.billing_services.processor
        assert app.state.checkout is app.state.billing_services.checkout
        assert app.state.plan_changes is app.state.billing_services.plan_changes
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            legacy_catalog = await client.get("/billing/catalog")
            docs = await client.get("/docs", headers={"Origin": "http://localhost:3000"})
            guarded_unknown_api = await client.post(
                "/api/not-a-route", headers={"Origin": "https://attacker.example"}
            )
    assert legacy_catalog.status_code == 200
    assert docs.headers["access-control-allow-origin"] == "http://localhost:3000"
    assert guarded_unknown_api.status_code == 403
    assert guarded_unknown_api.headers["cache-control"] == "no-store"
