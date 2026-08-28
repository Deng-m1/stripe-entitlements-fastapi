from __future__ import annotations

import json
import stat
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
import stripe

from scripts import e2e_stripe


def _manifest_args(output: Path) -> SimpleNamespace:
    return SimpleNamespace(
        database_url="postgresql://test",
        external_ref="browser-e2e-subject",
        endpoint_id="we_test_owned",
        description="stripe-entitlements-browser-e2e-test",
        url="https://example.test/webhooks/stripe",
        output=str(output),
    )


def _private_json(path: Path, payload: dict[str, Any]) -> None:
    path.write_text(json.dumps(payload), encoding="utf-8")
    path.chmod(0o600)


@pytest.mark.parametrize(
    ("value", "atoms", "canonical"),
    [
        ("1000", 1_000_000_000, "1000"),
        ("0.125000", 125_000, "0.125"),
        ("0.000001", 1, "0.000001"),
    ],
)
def test_browser_database_credit_expectation_uses_exact_atoms(
    value: str,
    atoms: int,
    canonical: str,
) -> None:
    amount = e2e_stripe._exact_credit_amount(value, field="test expectation")
    assert amount.atoms == atoms
    assert str(amount) == canonical


@pytest.mark.parametrize(
    "value",
    [1000, 0.1, True, "1e3", "0.0000001", "01", "0"],
)
def test_browser_database_credit_expectation_rejects_lossy_or_noncanonical_input(
    value: object,
) -> None:
    with pytest.raises(ValueError):
        e2e_stripe._exact_credit_amount(value, field="test expectation")


def test_verify_database_cli_preserves_exact_decimal_text() -> None:
    args = e2e_stripe.parser().parse_args(
        [
            "verify-database",
            "--database-url",
            "postgresql://test",
            "--external-ref",
            "browser-e2e-subject",
            "--event-api-version",
            "2026-06-24.dahlia",
            "--expected-credits",
            "0.125000",
        ]
    )
    assert args.expected_credits == "0.125000"


@pytest.mark.parametrize(
    ("policy", "reason", "settlement_atoms", "allocation_atoms"),
    [
        ("full_period_reset", "subscription_grant", 1_000_000_000, None),
        ("prorated_delta", "upgrade_delta_grant", 700_000_000, 700_000_000),
    ],
)
def test_verify_database_normalizes_every_nonzero_credit_fact_to_atoms(
    policy: str,
    reason: str,
    settlement_atoms: int,
    allocation_atoms: int | None,
) -> None:
    expected = e2e_stripe._browser_credit_expectations("1000.000000", policy)
    assert expected.balance.atoms == 1_000_000_000
    assert str(expected.balance) == "1000"
    assert expected.initial_grant_atoms == 300_000_000
    assert expected.settlement_reason == reason
    assert expected.settlement_grant_atoms == settlement_atoms
    assert expected.allocation_atoms == allocation_atoms


class _ManifestConnection:
    def __init__(self, row: dict[str, Any] | None) -> None:
        self.row = row
        self.closed = False

    async def fetchrow(self, *args: Any) -> dict[str, Any] | None:
        return self.row

    async def close(self) -> None:
        self.closed = True


class _StripeObject:
    def __init__(self, payload: dict[str, Any]) -> None:
        self.payload = payload
        self.expire_calls = 0
        self.cancel_calls = 0
        self.delete_calls = 0

    def __str__(self) -> str:
        return json.dumps(self.payload)

    def expire(self, **kwargs: Any) -> _StripeObject:
        self.expire_calls += 1
        self.payload["status"] = "expired"
        return self

    def cancel(self, **kwargs: Any) -> _StripeObject:
        self.cancel_calls += 1
        self.payload["status"] = "canceled"
        return self

    def delete(self, **kwargs: Any) -> _StripeObject:
        self.delete_calls += 1
        self.payload["deleted"] = True
        return self


class _StripePage:
    def __init__(self, items: list[Any]) -> None:
        self.items = items

    def auto_paging_iter(self):  # type: ignore[no-untyped-def]
        yield from self.items


def _invalid_request(*, code: str | None = None, status: int | None = None):
    return stripe.InvalidRequestError(
        "test Stripe request failure",
        None,
        code=code,
        http_status=status,
    )


@pytest.mark.parametrize(
    ("code", "status"),
    [("resource_missing", 400), (None, 404)],
)
def test_missing_resource_classifier_accepts_only_explicit_missing(
    code: str | None,
    status: int,
) -> None:
    assert e2e_stripe._is_missing_resource(_invalid_request(code=code, status=status))


@pytest.mark.parametrize("status", [400, 401, 409])
def test_missing_resource_classifier_rejects_other_stripe_errors(status: int) -> None:
    assert not e2e_stripe._is_missing_resource(
        _invalid_request(code="invalid_request", status=status)
    )


def test_delete_webhook_propagates_non_missing_stripe_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_placeholder")
    failure = _invalid_request(code="permission_denied", status=403)

    def fail_retrieve(*args: Any, **kwargs: Any) -> None:
        raise failure

    monkeypatch.setattr(e2e_stripe.stripe.WebhookEndpoint, "retrieve", fail_retrieve)
    with pytest.raises(stripe.InvalidRequestError) as caught:
        e2e_stripe.delete_webhook(SimpleNamespace(endpoint_id="we_test_owned", description="owned"))
    assert caught.value is failure


def test_delete_webhook_verifies_that_endpoint_is_no_longer_retrievable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_placeholder")
    endpoint = _StripeObject(
        {
            "id": "we_test_owned",
            "livemode": False,
            "description": "owned",
        }
    )
    retrieve_calls = 0

    def retrieve(*args: Any, **kwargs: Any) -> _StripeObject:
        nonlocal retrieve_calls
        retrieve_calls += 1
        if retrieve_calls == 1:
            return endpoint
        raise _invalid_request(code="resource_missing", status=400)

    monkeypatch.setattr(e2e_stripe.stripe.WebhookEndpoint, "retrieve", retrieve)
    e2e_stripe.delete_webhook(SimpleNamespace(endpoint_id="we_test_owned", description="owned"))

    assert endpoint.delete_calls == 1
    assert retrieve_calls == 2


def test_delete_webhook_fails_if_endpoint_remains_retrievable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_placeholder")
    endpoint = _StripeObject(
        {
            "id": "we_test_owned",
            "livemode": False,
            "description": "owned",
        }
    )
    monkeypatch.setattr(
        e2e_stripe.stripe.WebhookEndpoint,
        "retrieve",
        lambda *args, **kwargs: endpoint,
    )

    with pytest.raises(RuntimeError, match="remained present"):
        e2e_stripe.delete_webhook(SimpleNamespace(endpoint_id="we_test_owned", description="owned"))


@pytest.mark.asyncio
async def test_manifest_preserves_seeded_identity_when_database_fails(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    output = tmp_path / "cleanup.json"
    seeded = {
        "endpoint_id": "we_test_owned",
        "endpoint_description": "stripe-entitlements-browser-e2e-test",
        "endpoint_url": "https://example.test/webhooks/stripe",
        "external_ref": "browser-e2e-subject",
        "account_id": "f84809d8-f736-45f8-90ce-5ae16ba863f9",
        "checkout_session_id": "cs_test_owned",
        "stripe_customer_id": "cus_test_owned",
        "stripe_subscription_id": "sub_test_owned",
        "database_state_available": True,
    }
    _private_json(output, seeded)
    seeded_inode = output.stat().st_ino

    async def unavailable(*args: Any, **kwargs: Any) -> None:
        raise OSError("database unavailable after payment")

    monkeypatch.setattr(e2e_stripe.asyncpg, "connect", unavailable)
    await e2e_stripe.write_cleanup_manifest(_manifest_args(output))

    written = json.loads(output.read_text(encoding="utf-8"))
    for field in (
        "account_id",
        "checkout_session_id",
        "stripe_customer_id",
        "stripe_subscription_id",
    ):
        assert written[field] == seeded[field]
    assert written["database_state_available"] is False
    assert stat.S_IMODE(output.stat().st_mode) == 0o600
    assert output.stat().st_ino != seeded_inode


@pytest.mark.asyncio
async def test_manifest_atomically_records_database_identity(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    output = tmp_path / "cleanup.json"
    connection = _ManifestConnection(
        {
            "id": "d3033d8d-9662-409c-87cf-c401aec56f6c",
            "session_id": "cs_test_owned",
            "stripe_customer_id": "cus_test_owned",
            "stripe_subscription_id": "sub_test_owned",
        }
    )

    async def connect(*args: Any, **kwargs: Any) -> _ManifestConnection:
        return connection

    monkeypatch.setattr(e2e_stripe.asyncpg, "connect", connect)
    await e2e_stripe.write_cleanup_manifest(_manifest_args(output))

    written = json.loads(output.read_text(encoding="utf-8"))
    assert written["account_id"] == "d3033d8d-9662-409c-87cf-c401aec56f6c"
    assert written["checkout_session_id"] == "cs_test_owned"
    assert written["stripe_customer_id"] == "cus_test_owned"
    assert written["stripe_subscription_id"] == "sub_test_owned"
    assert written["database_state_available"] is True
    assert stat.S_IMODE(output.stat().st_mode) == 0o600
    assert connection.closed


@pytest.mark.asyncio
async def test_manifest_rejects_insecure_existing_file_without_overwriting_it(
    tmp_path: Path,
) -> None:
    output = tmp_path / "cleanup.json"
    output.write_text('{"account_id":"do-not-replace"}', encoding="utf-8")
    output.chmod(0o644)

    with pytest.raises(RuntimeError, match="must not be readable"):
        await e2e_stripe.write_cleanup_manifest(_manifest_args(output))

    assert output.read_text(encoding="utf-8") == '{"account_id":"do-not-replace"}'
    assert stat.S_IMODE(output.stat().st_mode) == 0o644


@pytest.mark.asyncio
async def test_manifest_rejects_database_identity_drift_without_overwriting_seed(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    output = tmp_path / "cleanup.json"
    seeded = {
        "endpoint_id": "we_test_owned",
        "endpoint_description": "stripe-entitlements-browser-e2e-test",
        "endpoint_url": "https://example.test/webhooks/stripe",
        "external_ref": "browser-e2e-subject",
        "account_id": "52ec81bf-5688-4d19-be52-ff9ad93ff5d5",
        "database_state_available": True,
    }
    _private_json(output, seeded)
    connection = _ManifestConnection(
        {
            "id": "a6b3396d-b7fe-4b8e-a010-9800f2815c8f",
            "session_id": None,
            "stripe_customer_id": None,
            "stripe_subscription_id": None,
        }
    )

    async def connect(*args: Any, **kwargs: Any) -> _ManifestConnection:
        return connection

    monkeypatch.setattr(e2e_stripe.asyncpg, "connect", connect)
    with pytest.raises(RuntimeError, match="identity changed for account_id"):
        await e2e_stripe.write_cleanup_manifest(_manifest_args(output))

    assert json.loads(output.read_text(encoding="utf-8")) == seeded


@pytest.mark.asyncio
async def test_manifest_rejects_unknown_fields_that_could_retain_secrets(
    tmp_path: Path,
) -> None:
    output = tmp_path / "cleanup.json"
    _private_json(
        output,
        {
            "external_ref": "browser-e2e-subject",
            "webhook_secret": "must-not-survive",
        },
    )

    with pytest.raises(RuntimeError, match=r"unsupported field.*webhook_secret"):
        await e2e_stripe.write_cleanup_manifest(_manifest_args(output))
    with pytest.raises(RuntimeError, match=r"unsupported field.*webhook_secret"):
        e2e_stripe.recover_cleanup_manifest(SimpleNamespace(manifest=str(output)))

    assert "must-not-survive" in output.read_text(encoding="utf-8")


def test_recovery_scans_account_owned_sessions_without_database_ids(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_placeholder")
    account_id = "76c14972-5648-4391-87ea-b0cc03a172f8"
    customer_id = "cus_test_recovered"
    subscription_id = "sub_test_recovered"
    manifest = tmp_path / "cleanup.json"
    _private_json(manifest, {"account_id": account_id})
    wrong_metadata = _StripeObject(
        {
            "id": "cs_test_wrong",
            "livemode": False,
            "client_reference_id": account_id,
            "metadata": {"account_id": "another-account"},
            "customer": None,
            "subscription": None,
            "status": "open",
        }
    )
    owned = _StripeObject(
        {
            "id": "cs_test_owned",
            "livemode": False,
            "client_reference_id": account_id,
            "metadata": {"account_id": account_id},
            "customer": customer_id,
            "subscription": subscription_id,
            "status": "open",
        }
    )
    subscription = _StripeObject(
        {
            "id": subscription_id,
            "livemode": False,
            "customer": customer_id,
            "metadata": {
                "account_id": account_id,
                "product_line": e2e_stripe.E2E_PRODUCT_LINE,
            },
            "status": "active",
        }
    )
    customer = _StripeObject({"id": customer_id, "livemode": False, "deleted": False})

    def list_sessions(*args: Any, **kwargs: Any) -> _StripePage:
        return _StripePage([wrong_metadata, owned])

    monkeypatch.setattr(e2e_stripe.stripe.checkout.Session, "list", list_sessions)
    monkeypatch.setattr(
        e2e_stripe.stripe.checkout.Session,
        "retrieve",
        lambda candidate, **kwargs: (
            owned
            if candidate == "cs_test_owned"
            else pytest.fail("unexpected Checkout Session identity")
        ),
    )
    monkeypatch.setattr(
        e2e_stripe.stripe.Subscription,
        "retrieve",
        lambda candidate, **kwargs: (
            subscription
            if candidate == subscription_id
            else pytest.fail("unexpected Subscription identity")
        ),
    )
    monkeypatch.setattr(
        e2e_stripe.stripe.Customer,
        "retrieve",
        lambda candidate, **kwargs: (
            customer if candidate == customer_id else pytest.fail("unexpected Customer identity")
        ),
    )
    e2e_stripe.recover_cleanup_manifest(SimpleNamespace(manifest=str(manifest)))

    assert wrong_metadata.expire_calls == 0
    assert owned.expire_calls == 1
    assert subscription.cancel_calls == 1
    assert customer.delete_calls == 1


def test_recovery_falls_back_to_account_scan_after_stored_session_is_missing(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_placeholder")
    account_id = "df399041-03c9-421f-9a78-7518572ff760"
    manifest = tmp_path / "cleanup.json"
    _private_json(
        manifest,
        {"account_id": account_id, "checkout_session_id": "cs_test_already_missing"},
    )
    owned = _StripeObject(
        {
            "id": "cs_test_recovered",
            "livemode": False,
            "client_reference_id": account_id,
            "metadata": {"account_id": account_id},
            "customer": None,
            "subscription": None,
            "status": "open",
        }
    )

    def retrieve(*args: Any, **kwargs: Any) -> None:
        raise _invalid_request(code="resource_missing", status=400)

    monkeypatch.setattr(e2e_stripe.stripe.checkout.Session, "retrieve", retrieve)
    monkeypatch.setattr(
        e2e_stripe.stripe.checkout.Session,
        "list",
        lambda *args, **kwargs: _StripePage([owned]),
    )

    e2e_stripe.recover_cleanup_manifest(SimpleNamespace(manifest=str(manifest)))
    assert owned.expire_calls == 1


def test_recovery_derives_and_deletes_customer_from_subscription_only_manifest(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_placeholder")
    account_id = "529885ff-aa01-4ebf-8cfe-a9b2b1032bf4"
    customer_id = "cus_test_subscription_only"
    subscription_id = "sub_test_subscription_only"
    manifest = tmp_path / "cleanup.json"
    _private_json(
        manifest,
        {
            "account_id": account_id,
            "stripe_subscription_id": subscription_id,
        },
    )
    subscription = _StripeObject(
        {
            "id": subscription_id,
            "livemode": False,
            "customer": customer_id,
            "metadata": {
                "account_id": account_id,
                "product_line": e2e_stripe.E2E_PRODUCT_LINE,
            },
            "status": "active",
        }
    )
    customer = _StripeObject({"id": customer_id, "livemode": False, "deleted": False})

    monkeypatch.setattr(
        e2e_stripe.stripe.checkout.Session,
        "list",
        lambda *args, **kwargs: _StripePage([]),
    )
    monkeypatch.setattr(
        e2e_stripe.stripe.Subscription,
        "retrieve",
        lambda candidate, **kwargs: (
            subscription
            if candidate == subscription_id
            else pytest.fail("unexpected Subscription identity")
        ),
    )
    monkeypatch.setattr(
        e2e_stripe.stripe.Customer,
        "retrieve",
        lambda candidate, **kwargs: (
            customer if candidate == customer_id else pytest.fail("unexpected Customer identity")
        ),
    )

    e2e_stripe.recover_cleanup_manifest(SimpleNamespace(manifest=str(manifest)))

    assert subscription.cancel_calls == 1
    assert customer.delete_calls == 1


def test_recovery_propagates_non_missing_session_retrieval_error(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_placeholder")
    manifest = tmp_path / "cleanup.json"
    _private_json(
        manifest,
        {
            "account_id": "7c3fc60e-51c0-46ed-8062-5edbcdd1e194",
            "checkout_session_id": "cs_test_owned",
        },
    )
    failure = _invalid_request(code="conflict", status=409)

    def retrieve(*args: Any, **kwargs: Any) -> None:
        raise failure

    def unexpected_list(*args: Any, **kwargs: Any) -> None:
        raise AssertionError("non-missing errors must not trigger an account-wide scan")

    monkeypatch.setattr(e2e_stripe.stripe.checkout.Session, "retrieve", retrieve)
    monkeypatch.setattr(e2e_stripe.stripe.checkout.Session, "list", unexpected_list)

    with pytest.raises(stripe.InvalidRequestError) as caught:
        e2e_stripe.recover_cleanup_manifest(SimpleNamespace(manifest=str(manifest)))
    assert caught.value is failure


def test_isolated_event_inbox_accepts_exact_run_coverage() -> None:
    assert e2e_stripe._require_isolated_event_inbox(7, 7) == 0


@pytest.mark.parametrize(("total", "matched"), [(8, 7), (6, 7)])
def test_isolated_event_inbox_rejects_any_count_mismatch(total: int, matched: int) -> None:
    with pytest.raises(RuntimeError, match="outside this isolated run"):
        e2e_stripe._require_isolated_event_inbox(total, matched)
