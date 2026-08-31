from __future__ import annotations

import re
from functools import lru_cache
from typing import Any, Literal, Self
from urllib.parse import urlsplit

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from .resources import default_plan_catalog_path

_VERSION = re.compile(r"^\d{4}-\d{2}-\d{2}\.[a-z][a-z0-9_]*$")
_SLUG = re.compile(r"^[a-z0-9][a-z0-9-]{0,127}$")
_LOOKUP_PREFIX = re.compile(r"^[a-z][a-z0-9-]{0,31}$")


def _visible(value: Any, *, field: str, max_bytes: int) -> str:
    if (
        type(value) is not str
        or not value
        or value != value.strip()
        or len(value.encode("utf-8")) > max_bytes
        or any(not character.isprintable() for character in value)
    ):
        raise ValueError(f"{field} must be a visible string up to {max_bytes} UTF-8 bytes")
    return value


def public_http_url_is_structurally_safe(value: str) -> bool:
    if type(value) is not str:
        return False
    try:
        parsed = urlsplit(value)
    except ValueError:
        return False
    return bool(
        parsed.scheme in {"http", "https"}
        and parsed.netloc
        and parsed.username is None
        and parsed.password is None
    )


def checkout_success_base_url_is_safe(value: str) -> bool:
    if not public_http_url_is_structurally_safe(value):
        return False
    parsed = urlsplit(value)
    return bool(not parsed.query and not parsed.fragment)


class DatabaseSettings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str
    database_pool_min: int = Field(default=1, ge=0, le=100)
    database_pool_max: int = Field(default=20, ge=1, le=100)
    database_pool_idle_timeout_ms: int = Field(default=10_000, ge=1_000, le=600_000)
    database_connect_timeout_ms: int = Field(default=10_000, ge=1_000, le=120_000)

    @field_validator("database_url")
    @classmethod
    def _database_url(cls, value: str) -> str:
        value = _visible(value, field="DATABASE_URL", max_bytes=2048)
        if not value.startswith(("postgresql://", "postgres://")):
            raise ValueError("DATABASE_URL must use PostgreSQL")
        return value

    @model_validator(mode="after")
    def _database_pool_bounds(self) -> Self:
        if self.database_pool_min > self.database_pool_max:
            raise ValueError("DATABASE_POOL_MIN must not exceed DATABASE_POOL_MAX")
        return self


class Settings(DatabaseSettings):
    stripe_secret_key: str
    stripe_webhook_secret: str
    stripe_api_version: str = "2026-06-24.dahlia"
    stripe_webhook_api_version: str
    stripe_portal_configuration_id: str | None = None
    product_line: str = "example-entitlements"
    lookup_prefix: str = "ent"
    plan_catalog_path: str = default_plan_catalog_path()
    checkout_success_url: str = "http://localhost:3000/billing/success"
    checkout_cancel_url: str = "http://localhost:3000/pricing"
    portal_return_url: str = "http://localhost:3000/account"
    frontend_origins: str = "http://localhost:3000"
    log_level: Literal["CRITICAL", "ERROR", "WARNING", "INFO", "DEBUG"] = "INFO"
    app_env: Literal["production", "development", "test"] = "production"
    demo_bearer_token: str | None = None
    demo_bearer_subject: str = "demo-user"
    demo_bearer_email: str | None = None
    billing_transition_policy: Literal["full_period_reset", "prorated_delta"] = "full_period_reset"

    @field_validator("stripe_secret_key")
    @classmethod
    def _stripe_secret_key(cls, value: str) -> str:
        value = _visible(value, field="STRIPE_SECRET_KEY", max_bytes=512)
        if not value.startswith(("sk_test_", "sk_live_")):
            raise ValueError("STRIPE_SECRET_KEY must be an sk_test_ or sk_live_ key")
        return value

    @field_validator("stripe_webhook_secret")
    @classmethod
    def _stripe_webhook_secret(cls, value: str) -> str:
        value = _visible(value, field="STRIPE_WEBHOOK_SECRET", max_bytes=512)
        if not value.startswith("whsec_"):
            raise ValueError("STRIPE_WEBHOOK_SECRET must start with whsec_")
        return value

    @field_validator("stripe_api_version", "stripe_webhook_api_version")
    @classmethod
    def _stripe_version(cls, value: str) -> str:
        value = _visible(value, field="Stripe API version", max_bytes=64)
        if _VERSION.fullmatch(value) is None:
            raise ValueError("Stripe API versions must use YYYY-MM-DD.release format")
        return value

    @field_validator("stripe_portal_configuration_id")
    @classmethod
    def _portal_configuration(cls, value: str | None) -> str | None:
        if value is None or value == "":
            return None
        return _visible(value, field="STRIPE_PORTAL_CONFIGURATION_ID", max_bytes=255)

    @field_validator("product_line")
    @classmethod
    def _product_line(cls, value: str) -> str:
        value = _visible(value, field="PRODUCT_LINE", max_bytes=128)
        if _SLUG.fullmatch(value) is None:
            raise ValueError("PRODUCT_LINE must be a lowercase slug")
        return value

    @field_validator("lookup_prefix")
    @classmethod
    def _lookup_prefix(cls, value: str) -> str:
        value = _visible(value, field="LOOKUP_PREFIX", max_bytes=32)
        if _LOOKUP_PREFIX.fullmatch(value) is None:
            raise ValueError("LOOKUP_PREFIX must be a lowercase slug without underscores")
        return value

    @field_validator(
        "plan_catalog_path",
        "checkout_success_url",
        "checkout_cancel_url",
        "portal_return_url",
        "frontend_origins",
    )
    @classmethod
    def _bounded_configuration_text(cls, value: str) -> str:
        return _visible(value, field="configuration value", max_bytes=8192)

    @field_validator("checkout_success_url", "checkout_cancel_url", "portal_return_url")
    @classmethod
    def _public_http_url(cls, value: str) -> str:
        if not public_http_url_is_structurally_safe(value):
            raise ValueError("billing redirect URLs must be origin-safe HTTP(S) URLs")
        return value

    @field_validator("checkout_success_url")
    @classmethod
    def _checkout_success_base_url(cls, value: str) -> str:
        if not checkout_success_base_url_is_safe(value):
            raise ValueError("CHECKOUT_SUCCESS_URL must not include a query or fragment")
        return value

    @field_validator("demo_bearer_token")
    @classmethod
    def _demo_token(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = _visible(value, field="DEMO_BEARER_TOKEN", max_bytes=512)
        if not value.isascii():
            raise ValueError("DEMO_BEARER_TOKEN must use visible ASCII characters")
        return value

    @field_validator("demo_bearer_subject")
    @classmethod
    def _demo_subject(cls, value: str) -> str:
        return _visible(value, field="DEMO_BEARER_SUBJECT", max_bytes=512)

    @field_validator("demo_bearer_email")
    @classmethod
    def _demo_email(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = _visible(value, field="DEMO_BEARER_EMAIL", max_bytes=320)
        if value.count("@") != 1 or any(character.isspace() for character in value):
            raise ValueError("DEMO_BEARER_EMAIL must contain one @ and no whitespace")
        return value


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]


@lru_cache
def get_database_settings() -> DatabaseSettings:
    return DatabaseSettings()  # type: ignore[call-arg]
