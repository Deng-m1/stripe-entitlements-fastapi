from __future__ import annotations

from collections.abc import AsyncIterator, Iterable, Mapping
from contextlib import asynccontextmanager
from typing import Any, cast

from fastapi import APIRouter, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from starlette._utils import get_route_path
from starlette.datastructures import Headers, MutableHeaders
from starlette.responses import JSONResponse
from starlette.routing import BaseRoute, Match
from starlette.types import ASGIApp, Lifespan, Message, Receive, Scope, Send

from .kernel import BillingKernel

_BILLING_STATE_ATTRIBUTE = "stripe_entitlements"


def normalize_billing_prefix(prefix: str) -> str:
    if prefix == "":
        return prefix
    if (
        not prefix.startswith("/")
        or prefix.endswith("/")
        or "//" in prefix
        or any(character in prefix for character in "{}?#")
    ):
        raise ValueError(
            "billing prefix must be empty or a slash-prefixed path without a trailing slash"
        )
    return prefix


class _BillingHTTPMiddleware:
    """Apply public browser policy and private response hardening by route class."""

    def __init__(
        self,
        app: ASGIApp,
        *,
        public_routes: tuple[BaseRoute, ...],
        internal_routes: tuple[BaseRoute, ...],
        origins: tuple[str, ...],
        prefix: str,
        scope_entire_app: bool,
    ) -> None:
        self._app = app
        self._public_routes = public_routes
        self._internal_routes = internal_routes
        self._origins = frozenset(origins)
        self._scope_entire_app = scope_entire_app
        self._api_prefixes = (f"{prefix}/api/", f"{prefix}/billing/")
        self._hardened_prefixes = (*self._api_prefixes, f"{prefix}/webhooks/")
        self._cors = CORSMiddleware(
            app,
            allow_origins=list(origins),
            allow_credentials=True,
            allow_methods=["GET", "POST", "OPTIONS"],
            allow_headers=[
                "Authorization",
                "Content-Type",
                "Idempotency-Key",
                "X-Stripe-Mode-Requirement",
            ],
        )

    @staticmethod
    def _matches(routes: tuple[BaseRoute, ...], scope: Scope) -> bool:
        return any(route.matches(scope)[0] is not Match.NONE for route in routes)

    def _harden_headers(
        self,
        path: str,
        headers: MutableHeaders,
        *,
        internal: bool = False,
    ) -> None:
        if internal or path.startswith(self._hardened_prefixes):
            headers["Cache-Control"] = "no-store"
            headers["Pragma"] = "no-cache"
            headers["X-Content-Type-Options"] = "nosniff"

    @staticmethod
    def _strip_browser_cors(headers: MutableHeaders) -> None:
        """Keep private workload responses outside every inner browser CORS policy."""

        for name in tuple(headers.keys()):
            if name.lower().startswith("access-control-"):
                del headers[name]

        vary_values = headers.getlist("Vary")
        if not vary_values:
            return
        vary_tokens = [
            token.strip()
            for value in vary_values
            for token in value.split(",")
            if token.strip() and token.strip().lower() != "origin"
        ]
        del headers["Vary"]
        if vary_tokens:
            headers["Vary"] = ", ".join(vary_tokens)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self._app(scope, receive, send)
            return

        public_route = self._scope_entire_app or self._matches(self._public_routes, scope)
        internal_route = not public_route and self._matches(self._internal_routes, scope)
        if not public_route and not internal_route:
            await self._app(scope, receive, send)
            return

        # Starlette route matching removes ``root_path`` before comparing routes.
        # Apply the same semantics to path policy so mounted/sub-path deployments
        # cannot silently lose Origin rejection or response hardening.
        path = get_route_path(scope)
        headers = Headers(scope=scope)
        origin = headers.get("Origin")
        if (
            public_route
            and scope.get("method") in {"POST", "PUT", "PATCH", "DELETE"}
            and path.startswith(self._api_prefixes)
            and origin is not None
            and origin not in self._origins
        ):
            response = JSONResponse({"error": "request origin is not allowed"}, status_code=403)
            self._harden_headers(path, response.headers)
            await response(scope, receive, send)
            return

        async def send_hardened(message: Message) -> None:
            if message["type"] == "http.response.start":
                response_headers = MutableHeaders(scope=message)
                self._harden_headers(path, response_headers, internal=internal_route)
                if internal_route:
                    self._strip_browser_cors(response_headers)
            await send(message)

        if public_route:
            await self._cors(scope, receive, send_hardened)
        else:
            await self._app(scope, receive, send_hardened)


def _install_billing(
    app: FastAPI,
    kernel: BillingKernel,
    *,
    prefix: str = "",
    internal_routers: Iterable[APIRouter] = (),
    expose_legacy_state: bool = False,
    scope_entire_app: bool = False,
    configure_logging: bool = False,
) -> APIRouter:
    """Install billing routes, scoped middleware, and one composed lifespan."""

    prefix = normalize_billing_prefix(prefix)
    if app.middleware_stack is not None:
        raise RuntimeError("billing must be installed before the FastAPI app starts")
    if hasattr(app.state, _BILLING_STATE_ATTRIBUTE):
        raise RuntimeError("billing is already installed on this FastAPI app")

    # Import lazily so app.create_app can use this installer without a module cycle.
    from .app import create_billing_router

    router = create_billing_router(kernel, prefix=prefix)
    public_routes = tuple(router.routes)
    installed_internal_routes: list[BaseRoute] = []
    for internal_router in internal_routers:
        previous_route_count = len(router.routes)
        router.include_router(internal_router)
        installed_internal_routes.extend(router.routes[previous_route_count:])

    app.include_router(router)
    app.add_middleware(
        _BillingHTTPMiddleware,
        public_routes=public_routes,
        internal_routes=tuple(installed_internal_routes),
        origins=kernel.origins,
        prefix=prefix,
        scope_entire_app=scope_entire_app,
    )
    billing_middleware = app.user_middleware[0]
    host_lifespan = app.router.lifespan_context

    @asynccontextmanager
    async def installed_lifespan(
        installed_app: FastAPI,
    ) -> AsyncIterator[Mapping[str, Any] | None]:
        if installed_internal_routes:
            try:
                billing_index = installed_app.user_middleware.index(billing_middleware)
            except ValueError as exc:
                raise RuntimeError(
                    "installed billing middleware is missing from the FastAPI application"
                ) from exc
            outer_middleware = installed_app.user_middleware[:billing_index]
            if any(
                isinstance(middleware.cls, type) and issubclass(middleware.cls, CORSMiddleware)
                for middleware in outer_middleware
            ):
                raise RuntimeError(
                    "internal billing routes require host CORSMiddleware to be registered "
                    "before install_billing; register CORS first and call install_billing last"
                )
        # The host starts first so it may connect an injected, host-owned Database.
        # Billing then observes that pool and never closes it. Shutdown is reversed.
        async with host_lifespan(installed_app) as host_state:
            async with kernel.lifespan(
                installed_app,
                expose_legacy_state=expose_legacy_state,
                configure_logging=configure_logging,
            ):
                yield host_state

    app.router.lifespan_context = cast(Lifespan[Any], installed_lifespan)
    setattr(app.state, _BILLING_STATE_ATTRIBUTE, kernel)
    return router


def install_billing(
    app: FastAPI,
    kernel: BillingKernel,
    *,
    prefix: str = "",
    internal_routers: Iterable[APIRouter] = (),
) -> APIRouter:
    """Install billing into a host app without affecting unrelated host routes."""

    return _install_billing(
        app,
        kernel,
        prefix=prefix,
        internal_routers=internal_routers,
    )


def _install_standalone_billing(app: FastAPI, kernel: BillingKernel) -> APIRouter:
    """Preserve the reference app's historical app-wide CORS and state behavior."""

    return _install_billing(
        app,
        kernel,
        expose_legacy_state=True,
        scope_entire_app=True,
        configure_logging=True,
    )
