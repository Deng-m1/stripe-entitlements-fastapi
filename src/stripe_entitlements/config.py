from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str
    stripe_secret_key: str
    stripe_webhook_secret: str
    product_line: str = "example-entitlements"
    lookup_prefix: str = "ent"
    plan_catalog_path: str = "plans.toml"
    log_level: str = "INFO"


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
