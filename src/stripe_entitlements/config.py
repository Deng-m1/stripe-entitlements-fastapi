from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str
    stripe_secret_key: str
    stripe_webhook_secret: str
    stripe_api_version: str = "2026-06-24.dahlia"
    stripe_webhook_api_version: str
    stripe_portal_configuration_id: str | None = None
    product_line: str = "example-entitlements"
    lookup_prefix: str = "ent"
    plan_catalog_path: str = "plans.toml"
    checkout_success_url: str = "http://localhost:3000/billing/success"
    checkout_cancel_url: str = "http://localhost:3000/pricing"
    portal_return_url: str = "http://localhost:3000/account"
    frontend_origins: str = "http://localhost:3000"
    log_level: str = "INFO"
    app_env: str = "production"
    demo_bearer_token: str | None = None
    demo_bearer_subject: str = "demo-user"
    demo_bearer_email: str | None = None


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
