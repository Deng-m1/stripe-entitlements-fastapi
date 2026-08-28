from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from scripts import browser_e2e_app, e2e_stripe
from stripe_entitlements.auth_starters import PersonalJwtAuthAdapter

PERSONAL_SUBJECT = "7e4a3d62-e503-4f07-8f23-980056172964"
WORKLOAD_SUBJECT = "bcd6b1ab-0185-4b2f-8a58-85b28c12bbb3"
ISSUER = "https://127.0.0.1:8000/e2e/issuer"


def _configure_host(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    jwks_path = tmp_path / "jwks.json"
    tokens_path = tmp_path / "tokens.json"
    e2e_stripe.create_auth_fixture(
        SimpleNamespace(
            issuer=ISSUER,
            personal_audience="browser-audience",
            personal_subject=PERSONAL_SUBJECT,
            email="personal@example.test",
            workload_audience="workload-audience",
            workload_subject=WORKLOAD_SUBJECT,
            jwks_output=str(jwks_path),
            token_output=str(tokens_path),
        )
    )
    tokens = json.loads(tokens_path.read_text(encoding="utf-8"))
    values = {
        "DATABASE_URL": "postgresql://postgres@127.0.0.1:5432/browser_e2e_test",
        "STRIPE_SECRET_KEY": "sk_test_browser_e2e_fixture",
        "STRIPE_WEBHOOK_SECRET": "whsec_browser_e2e_fixture",
        "STRIPE_WEBHOOK_API_VERSION": "2026-06-24.dahlia",
        "STRIPE_PORTAL_CONFIGURATION_ID": "bpc_browser_e2e_fixture",
        "CHECKOUT_SUCCESS_URL": "https://127.0.0.1:3000/billing/success",
        "CHECKOUT_CANCEL_URL": "https://127.0.0.1:3000/pricing",
        "PORTAL_RETURN_URL": "https://127.0.0.1:3000/account",
        "FRONTEND_ORIGINS": "https://127.0.0.1:3000",
        "APP_ENV": "production",
        "E2E_PERSONAL_JWKS_FILE": str(jwks_path),
        "E2E_JWT_ISSUER": ISSUER,
        "E2E_PERSONAL_JWT_AUDIENCE": "browser-audience",
        "E2E_WORKLOAD_JWT_AUDIENCE": "workload-audience",
        "E2E_WORKLOAD_SUBJECT": WORKLOAD_SUBJECT,
        "E2E_WORKLOAD_JWT": tokens["workload_token"],
        "E2E_EXPECTED_OWNER_EXTERNAL_REF": f"v1:user:{PERSONAL_SUBJECT}",
        "E2E_JOB_SUCCESS_KEY": "browser-e2e:test:success",
        "E2E_JOB_FAILURE_KEY": "browser-e2e:test:failure",
    }
    for name, value in values.items():
        monkeypatch.setenv(name, value)


def test_browser_e2e_host_composes_personal_auth_and_private_workload_router(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    _configure_host(monkeypatch, tmp_path)

    app = browser_e2e_app.create_app()
    paths = {
        path for route in app.routes if isinstance((path := getattr(route, "path", None)), str)
    }
    kernel = app.state.stripe_entitlements

    assert isinstance(kernel.auth_adapter, PersonalJwtAuthAdapter)
    assert kernel.settings.app_env == "production"
    assert {
        "/e2e/issuer/.well-known/jwks.json",
        "/api/e2e/portal-evidence",
        "/api/e2e/jobs",
    }.issubset(paths)
    assert {
        "/api/account",
        "/api/billing/portal",
        "/internal/v1/entitlements/check",
        "/internal/v1/credits/charge",
        "/internal/v1/credits/refund",
    }.issubset(app.openapi()["paths"])


def test_browser_e2e_host_refuses_to_start_without_workload_identity(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    _configure_host(monkeypatch, tmp_path)
    monkeypatch.delenv("E2E_WORKLOAD_JWT")

    with pytest.raises(RuntimeError, match="E2E_WORKLOAD_JWT"):
        browser_e2e_app.create_app()
