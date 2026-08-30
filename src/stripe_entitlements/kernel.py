from __future__ import annotations

import logging
import threading
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from urllib.parse import urlsplit

from fastapi import FastAPI

from .auth import (
    AuthAccountAdapter,
    DemoBearerAuthAdapter,
    RejectAllAuthAdapter,
)
from .catalog import PlanCatalog
from .checkout import CheckoutCoordinator
from .config import (
    Settings,
    checkout_success_base_url_is_safe,
    get_settings,
    public_http_url_is_structurally_safe,
)
from .credit_packs import CreditPackCoordinator
from .database import Database
from .entitlements import EntitlementService
from .pack_reconcile import CreditPackReconciliationService
from .plan_changes import PlanChangeCoordinator
from .processor import EventProcessor
from .stripe_gateway import StripeGateway

_DATABASE_BINDING_ATTRIBUTE = "_stripe_entitlements_billing_kernel_binding"
_DATABASE_BINDING_LOCK = threading.Lock()


def _bind_database_to_kernel(database: Database) -> object:
    """Claim one Database object for one kernel without retaining the kernel itself."""

    binding = object()
    with _DATABASE_BINDING_LOCK:
        if getattr(database, _DATABASE_BINDING_ATTRIBUTE, None) is not None:
            raise RuntimeError("this Database is already bound to another BillingKernel")
        setattr(database, _DATABASE_BINDING_ATTRIBUTE, binding)
    return binding


@dataclass(frozen=True, slots=True)
class BillingServices:
    """Request-time services that share one connected billing database pool."""

    processor: EventProcessor
    checkout: CheckoutCoordinator
    plan_changes: PlanChangeCoordinator
    entitlements: EntitlementService
    credit_packs: CreditPackCoordinator
    credit_pack_reconciliation: CreditPackReconciliationService


class BillingKernel:
    """Validated billing configuration and its lifespan-owned service graph."""

    def __init__(
        self,
        settings: Settings | None = None,
        *,
        database: Database | None = None,
        gateway: StripeGateway | None = None,
        auth_adapter: AuthAccountAdapter | None = None,
    ) -> None:
        self.settings = settings or get_settings()
        self.database = database or Database.from_settings(self.settings)
        self.gateway = gateway or StripeGateway(
            self.settings.stripe_secret_key,
            self.settings.stripe_webhook_secret,
            self.settings.product_line,
            api_version=self.settings.stripe_api_version,
            portal_configuration_id=self.settings.stripe_portal_configuration_id,
            checkout_success_url=self.settings.checkout_success_url,
            checkout_cancel_url=self.settings.checkout_cancel_url,
            portal_return_url=self.settings.portal_return_url,
        )
        self.stripe_test_mode = self._validate_stripe_mode()
        self.origins = self._validate_origins()
        self.auth_adapter = auth_adapter or self._default_auth_adapter()
        self.catalog = PlanCatalog.from_toml(
            self.settings.plan_catalog_path, self.settings.lookup_prefix
        )
        self._services: BillingServices | None = None
        self._running = False
        self._database_binding = _bind_database_to_kernel(self.database)

    def _validate_stripe_mode(self) -> bool:
        gateway_secret_key = getattr(self.gateway, "secret_key", "")
        if not isinstance(gateway_secret_key, str) or not gateway_secret_key.startswith(
            ("sk_test_", "sk_live_")
        ):
            raise ValueError("billing gateway must expose an sk_test_ or sk_live_ secret key")
        if not self.settings.stripe_secret_key.startswith(("sk_test_", "sk_live_")):
            raise ValueError("configured Stripe key must be an sk_test_ or sk_live_ secret key")
        settings_test_mode = self.settings.stripe_secret_key.startswith("sk_test_")
        gateway_test_mode = gateway_secret_key.startswith("sk_test_")
        if settings_test_mode != gateway_test_mode:
            raise ValueError("settings and billing gateway Stripe modes do not match")
        gateway_api_version = getattr(self.gateway, "api_version", None)
        if gateway_api_version != self.settings.stripe_api_version:
            raise ValueError("settings and billing gateway Stripe API versions do not match")
        gateway_product_line = getattr(self.gateway, "product_line", None)
        if gateway_product_line != self.settings.product_line:
            raise ValueError("settings and billing gateway product lines do not match")
        gateway_configuration = (
            (
                "Checkout success URLs",
                "checkout_success_url",
                self.settings.checkout_success_url,
            ),
            (
                "Checkout cancel URLs",
                "checkout_cancel_url",
                self.settings.checkout_cancel_url,
            ),
            ("Portal return URLs", "portal_return_url", self.settings.portal_return_url),
            (
                "Portal configuration IDs",
                "portal_configuration_id",
                self.settings.stripe_portal_configuration_id,
            ),
        )
        missing = object()
        for label, attribute, expected in gateway_configuration:
            if getattr(self.gateway, attribute, missing) != expected:
                raise ValueError(f"settings and billing gateway {label} do not match")
        if not self.settings.stripe_webhook_secret.startswith("whsec_"):
            raise ValueError("Stripe webhook secret must start with whsec_")
        return gateway_test_mode

    def _validate_origins(self) -> tuple[str, ...]:
        redirect_urls = {
            "CHECKOUT_SUCCESS_URL": self.settings.checkout_success_url,
            "CHECKOUT_CANCEL_URL": self.settings.checkout_cancel_url,
            "PORTAL_RETURN_URL": self.settings.portal_return_url,
        }
        for field, value in redirect_urls.items():
            if not public_http_url_is_structurally_safe(value):
                raise ValueError(f"{field} must be an origin-safe HTTP(S) URL")
        if not checkout_success_base_url_is_safe(self.settings.checkout_success_url):
            raise ValueError("CHECKOUT_SUCCESS_URL must not include a query or fragment")

        origins = tuple(
            origin
            for item in self.settings.frontend_origins.split(",")
            if (origin := item.strip().rstrip("/"))
        )
        if "*" in origins:
            raise ValueError("credentialed billing CORS cannot allow a wildcard origin")
        for origin in origins:
            parsed_origin = urlsplit(origin)
            if (
                parsed_origin.scheme not in {"http", "https"}
                or not parsed_origin.netloc
                or parsed_origin.username is not None
                or parsed_origin.password is not None
                or parsed_origin.path not in {"", "/"}
                or parsed_origin.query
                or parsed_origin.fragment
            ):
                raise ValueError("FRONTEND_ORIGINS entries must be bare HTTP(S) origins")
        if not self.stripe_test_mode:
            public_urls = {
                **redirect_urls,
                **{f"FRONTEND_ORIGINS[{index}]": origin for index, origin in enumerate(origins)},
            }
            for field, value in public_urls.items():
                parsed = urlsplit(value)
                if (
                    parsed.scheme != "https"
                    or not parsed.netloc
                    or parsed.username is not None
                    or parsed.password is not None
                    or parsed.fragment
                ):
                    raise ValueError(f"{field} must be an origin-safe HTTPS URL in live mode")
        return origins

    def _default_auth_adapter(self) -> AuthAccountAdapter:
        if (
            self.settings.app_env == "development"
            and self.settings.stripe_secret_key.startswith("sk_test_")
            and self.settings.demo_bearer_token
        ):
            return DemoBearerAuthAdapter(
                self.settings.demo_bearer_token,
                self.settings.demo_bearer_subject,
                self.settings.demo_bearer_email,
            )
        return RejectAllAuthAdapter()

    def require_services(self) -> BillingServices:
        """Return initialized services or fail before/after the installed lifespan."""

        if self._services is None:
            raise RuntimeError("billing services are available only inside the app lifespan")
        return self._services

    @property
    def services(self) -> BillingServices:
        """Stable property form for dependencies that resolve services per request."""

        return self.require_services()

    @asynccontextmanager
    async def lifespan(
        self,
        app: FastAPI,
        *,
        expose_legacy_state: bool = False,
        configure_logging: bool = False,
    ) -> AsyncIterator[None]:
        """Initialize exactly one service graph and close only a pool opened here."""

        if self._running:
            raise RuntimeError("this BillingKernel already has an active lifespan")
        self._running = True
        if configure_logging:
            logging.basicConfig(level=self.settings.log_level)
        connected_here = self.database.pool is None
        try:
            if connected_here:
                await self.database.connect()
            pool = self.database.require_pool()
            processor = EventProcessor(
                pool,
                self.catalog,
                self.settings.product_line,
                expected_livemode=not self.stripe_test_mode,
                expected_api_version=self.settings.stripe_webhook_api_version,
            )
            services = BillingServices(
                processor=processor,
                checkout=CheckoutCoordinator(pool),
                plan_changes=PlanChangeCoordinator(
                    pool,
                    self.catalog,
                    self.gateway,
                    transition_policy=self.settings.billing_transition_policy,
                ),
                entitlements=EntitlementService(pool, self.catalog),
                credit_packs=CreditPackCoordinator(pool, self.catalog),
                credit_pack_reconciliation=CreditPackReconciliationService(
                    pool,
                    processor,
                    self.gateway,
                ),
            )
            self._services = services
            app.state.stripe_entitlements = self
            if expose_legacy_state:
                app.state.billing_kernel = self
                app.state.billing_services = services
                app.state.database = self.database
                app.state.gateway = self.gateway
                app.state.processor = services.processor
                app.state.checkout = services.checkout
                app.state.plan_changes = services.plan_changes
            yield
        finally:
            self._services = None
            try:
                if connected_here:
                    await self.database.close()
            finally:
                self._running = False
