from __future__ import annotations

import pytest
from pydantic import ValidationError

from stripe_entitlements.config import Settings
from stripe_entitlements.resources import default_plan_catalog_path


def _valid(**overrides: object) -> dict[str, object]:
    values: dict[str, object] = {
        "database_url": "postgresql://user:password@127.0.0.1:5432/billing",
        "stripe_secret_key": "sk_test_dummy",
        "stripe_webhook_secret": "whsec_dummy",
        "stripe_webhook_api_version": "2026-06-24.dahlia",
        "plan_catalog_path": default_plan_catalog_path(),
    }
    values.update(overrides)
    return values


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("database_url", "mysql://localhost/billing", "PostgreSQL"),
        ("stripe_secret_key", "rk_test_restricted", "sk_test_"),
        ("stripe_webhook_secret", "secret", "whsec_"),
        ("stripe_api_version", "latest", "YYYY-MM-DD"),
        ("stripe_webhook_api_version", "2026-06-24", "YYYY-MM-DD"),
        ("stripe_portal_configuration_id", "pc_wrong", "bpc_"),
        ("product_line", "Upper_Product", "lowercase slug"),
        ("lookup_prefix", "bad_prefix", "without underscores"),
        ("log_level", "info", "Input should be"),
        ("app_env", "staging", "Input should be"),
        ("frontend_origins", "https://app.example\u200b", "visible string"),
        (
            "checkout_success_url",
            "https://app.example/billing/success?campaign=launch",
            "query or fragment",
        ),
        (
            "checkout_success_url",
            "https://app.example/billing/success#done",
            "query or fragment",
        ),
        ("demo_bearer_token", "token\x7f", "visible string"),
        ("demo_bearer_email", "missing-at.example.test", "one @"),
        ("demo_bearer_email", "has space@example.test", "no whitespace"),
    ],
)
def test_settings_fail_early_on_ambiguous_or_unsafe_values(
    field: str, value: object, message: str
) -> None:
    with pytest.raises(ValidationError, match=message):
        Settings(**_valid(**{field: value}))  # type: ignore[arg-type]


@pytest.mark.parametrize("secret_key", ["sk_test_dummy", "sk_live_dummy"])
def test_settings_accept_explicit_test_and_live_secret_modes(secret_key: str) -> None:
    settings = Settings(**_valid(stripe_secret_key=secret_key))  # type: ignore[arg-type]
    assert settings.stripe_secret_key == secret_key
    assert settings.product_line == "example-entitlements"
    assert settings.log_level == "INFO"
