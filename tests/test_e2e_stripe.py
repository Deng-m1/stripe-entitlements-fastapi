from __future__ import annotations

import json
import stat
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import jwt
import pytest
import stripe

from scripts import e2e_stripe
from stripe_entitlements.event_audit import redacted_event_snapshot


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


def test_checkout_cleanup_classifies_subscription_and_pack_sessions_separately() -> None:
    account_id = "76c14972-5648-4391-87ea-b0cc03a172f8"
    base = {
        "livemode": False,
        "client_reference_id": account_id,
        "metadata": {"account_id": account_id},
    }

    assert e2e_stripe._owned_checkout_kind(base, account_id) == "subscription"
    assert (
        e2e_stripe._owned_checkout_kind(
            {**base, "metadata": {**base["metadata"], "billing_kind": "credit_pack"}},
            account_id,
        )
        == "credit_pack"
    )
    assert (
        e2e_stripe._owned_checkout_kind(
            {**base, "metadata": {**base["metadata"], "billing_kind": "unknown"}},
            account_id,
        )
        is None
    )
    assert e2e_stripe._owned_checkout_kind({**base, "livemode": True}, account_id) is None


def test_browser_verifier_fields_survive_the_minimal_event_audit_allowlist() -> None:
    account_id = "76c14972-5648-4391-87ea-b0cc03a172f8"
    snapshot = redacted_event_snapshot(
        {
            "id": "evt_pack_audit",
            "type": "payment_intent.succeeded",
            "api_version": "2026-06-24.dahlia",
            "livemode": False,
            "data": {
                "object": {
                    "id": "pi_pack_audit",
                    "client_reference_id": account_id,
                    "customer": "cus_pack_audit",
                    "latest_charge": "ch_pack_audit",
                    "amount_received": 1500,
                    "currency": "usd",
                    "status": "succeeded",
                    "metadata": {
                        "account_id": account_id,
                        "billing_kind": "credit_pack",
                        "pack_key": "boost-100",
                        "pack_credits": "100",
                        "price_amount": "1500",
                        "currency": "usd",
                        "expires_days": "365",
                        "lookup_key": "ent_pack_boost-100",
                    },
                    "description": "must never enter the verifier audit projection",
                }
            },
        }
    )
    audited = snapshot["data"]["object"]
    assert audited["client_reference_id"] == account_id
    assert audited["customer"] == "cus_pack_audit"
    assert audited["latest_charge"] == "ch_pack_audit"
    assert audited["amount_received"] == 1500
    assert audited["currency"] == "usd"
    assert audited["status"] == "succeeded"
    assert audited["metadata"]["billing_kind"] == "credit_pack"
    assert "description" not in audited


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


def test_browser_auth_fixture_uses_signed_personal_and_workload_audiences(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    jwks_path = tmp_path / "jwks.json"
    token_path = tmp_path / "tokens.json"
    issuer = "https://127.0.0.1:8443/e2e/issuer"
    personal_subject = "7e4a3d62-e503-4f07-8f23-980056172964"
    workload_subject = "bcd6b1ab-0185-4b2f-8a58-85b28c12bbb3"
    e2e_stripe.create_auth_fixture(
        SimpleNamespace(
            issuer=issuer,
            personal_audience="browser-audience",
            personal_subject=personal_subject,
            email="personal@example.test",
            workload_audience="workload-audience",
            workload_subject=workload_subject,
            jwks_output=str(jwks_path),
            token_output=str(token_path),
        )
    )

    jwks = json.loads(jwks_path.read_text(encoding="utf-8"))
    tokens = json.loads(token_path.read_text(encoding="utf-8"))
    signing_key = jwt.PyJWK.from_dict(jwks["keys"][0]).key
    personal = jwt.decode(
        tokens["personal_token"],
        signing_key,
        algorithms=["RS256"],
        issuer=issuer,
        audience="browser-audience",
    )
    workload = jwt.decode(
        tokens["workload_token"],
        signing_key,
        algorithms=["RS256"],
        issuer=issuer,
        audience="workload-audience",
    )

    assert stat.S_IMODE(jwks_path.stat().st_mode) == 0o600
    assert stat.S_IMODE(token_path.stat().st_mode) == 0o600
    assert personal["sub"] == personal_subject
    assert personal["email_verified"] is True
    assert workload["sub"] == workload_subject
    assert personal["aud"] != workload["aud"]
    assert "private" not in json.dumps(jwks).lower()
    output = capsys.readouterr().out
    assert "created ephemeral signed Personal JWT" in output
    assert tokens["personal_token"] not in output
    assert tokens["workload_token"] not in output


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("personal_subject", "not-a-uuid"),
        ("workload_subject", "00000000-0000-0000-0000-000000000000"),
        ("issuer", "http://identity.example.test"),
        ("email", "not-an-email"),
    ],
)
def test_browser_auth_fixture_rejects_invalid_identity_contract(
    tmp_path: Path,
    field: str,
    value: str,
) -> None:
    values = {
        "issuer": "https://identity.example.test/e2e/issuer",
        "personal_audience": "browser-audience",
        "personal_subject": "7e4a3d62-e503-4f07-8f23-980056172964",
        "email": "personal@example.test",
        "workload_audience": "workload-audience",
        "workload_subject": "bcd6b1ab-0185-4b2f-8a58-85b28c12bbb3",
        "jwks_output": str(tmp_path / "jwks.json"),
        "token_output": str(tmp_path / "tokens.json"),
    }
    values[field] = value
    with pytest.raises(ValueError):
        e2e_stripe.create_auth_fixture(SimpleNamespace(**values))
    assert not (tmp_path / "jwks.json").exists()
    assert not (tmp_path / "tokens.json").exists()


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


def _browser_job_rows() -> list[dict[str, Any]]:
    return [
        {
            "idempotency_key": "job-success",
            "amount": 80_000_000,
            "restored_credits": 0,
            "refunded_at": None,
            "allocated_credits": 80_000_000,
            "allocation_refunds": 0,
            "source_types": ["subscription"],
        },
        {
            "idempotency_key": "job-failure",
            "amount": 20_000_000,
            "restored_credits": 20_000_000,
            "refunded_at": "2026-08-28T00:00:00Z",
            "allocated_credits": 20_000_000,
            "allocation_refunds": 20_000_000,
            "source_types": ["subscription"],
        },
    ]


def test_browser_job_verifier_binds_success_and_refund_to_exact_debits() -> None:
    e2e_stripe._verify_browser_job_debits(
        _browser_job_rows(),
        success_key="job-success",
        success_credits=e2e_stripe._exact_credit_amount("80", field="success"),
        refunded_key="job-failure",
        refunded_credits=e2e_stripe._exact_credit_amount("20", field="refund"),
    )


@pytest.mark.parametrize(
    ("row_index", "field", "value", "message"),
    [
        (0, "restored_credits", 1, "successful"),
        (0, "source_types", ["credit_pack"], "successful"),
        (1, "refunded_at", None, "failed"),
        (1, "allocation_refunds", 19_999_999, "failed"),
    ],
)
def test_browser_job_verifier_rejects_incomplete_or_cross_source_convergence(
    row_index: int,
    field: str,
    value: object,
    message: str,
) -> None:
    rows = _browser_job_rows()
    rows[row_index][field] = value
    with pytest.raises(RuntimeError, match=message):
        e2e_stripe._verify_browser_job_debits(
            rows,
            success_key="job-success",
            success_credits=e2e_stripe._exact_credit_amount("80", field="success"),
            refunded_key="job-failure",
            refunded_credits=e2e_stripe._exact_credit_amount("20", field="refund"),
        )


def _pack_payment_event(account_id: str) -> dict[str, Any]:
    return {
        "id": "evt_test_pack_gate",
        "type": "payment_intent.succeeded",
        "livemode": False,
        "data": {
            "object": {
                "id": "pi_test_sensitive_identity",
                "status": "succeeded",
                "latest_charge": "ch_test_sensitive_identity",
                "metadata": {
                    "billing_kind": "credit_pack",
                    "pack_schema_version": "1",
                    "account_id": account_id,
                    "credit_pack_order_id": "75807e8b-20cd-43e3-8237-f56f73067b4b",
                    "pack_key": "boost-100",
                },
            }
        },
    }


def test_pack_webhook_gate_retains_only_non_sensitive_correlation_identity() -> None:
    account_id = "9ce43744-656d-446b-ac53-a0c4aa120dcf"
    identity = e2e_stripe._pack_gate_identity(
        _pack_payment_event(account_id),
        account_id,
    )
    assert identity == {
        "stripe_event_id": "evt_test_pack_gate",
        "account_id": account_id,
        "credit_pack_order_id": "75807e8b-20cd-43e3-8237-f56f73067b4b",
        "pack_key": "boost-100",
    }
    serialized = json.dumps(identity)
    assert "pi_test_sensitive_identity" not in serialized
    assert "ch_test_sensitive_identity" not in serialized


@pytest.mark.parametrize(
    "mutation",
    [
        {"livemode": True},
        {"type": "checkout.session.completed"},
    ],
)
def test_pack_webhook_gate_rejects_non_test_or_non_payment_fact(
    mutation: dict[str, Any],
) -> None:
    account_id = "9ce43744-656d-446b-ac53-a0c4aa120dcf"
    payload = _pack_payment_event(account_id)
    payload.update(mutation)
    assert e2e_stripe._pack_gate_identity(payload, account_id) is None
    assert (
        e2e_stripe._pack_gate_identity(
            _pack_payment_event(account_id),
            "8d399471-0e1f-4404-a84c-e44a6991dc14",
        )
        is None
    )


@pytest.mark.asyncio
async def test_pack_webhook_gate_control_files_are_private_and_identity_bound(
    tmp_path: Path,
) -> None:
    state_dir = tmp_path / "gate"
    account_id = "9ce43744-656d-446b-ac53-a0c4aa120dcf"
    e2e_stripe.arm_credit_pack_gate(
        SimpleNamespace(state_dir=str(state_dir), account_id=account_id)
    )
    identity = e2e_stripe._pack_gate_identity(
        _pack_payment_event(account_id),
        account_id,
    )
    assert identity is not None
    e2e_stripe._write_private_json_atomic(state_dir / "captured.json", identity)
    e2e_stripe.release_credit_pack_gate(SimpleNamespace(state_dir=str(state_dir)))
    e2e_stripe._write_private_json_atomic(state_dir / "forwarded.json", identity)
    await e2e_stripe.wait_credit_pack_gate(
        SimpleNamespace(
            state_dir=str(state_dir),
            phase="forwarded",
            timeout_seconds=1,
        )
    )

    assert stat.S_IMODE(state_dir.stat().st_mode) == 0o700
    for path in state_dir.iterdir():
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
        content = path.read_text(encoding="utf-8")
        assert "sk_" not in content
        assert "whsec_" not in content
        assert "pi_test_sensitive_identity" not in content
        assert "ch_test_sensitive_identity" not in content


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


def _pack_cleanup_objects() -> tuple[_StripeObject, _StripeObject, _StripeObject]:
    account_id = "8dd9153e-3629-4418-817c-b4b21d1637df"
    order_id = "4dff1f2c-6543-4017-bb9d-6cbb75d01fb8"
    customer_id = "cus_test_pack_cleanup"
    session = _StripeObject(
        {
            "id": "cs_test_pack_cleanup",
            "livemode": False,
            "mode": "payment",
            "status": "complete",
            "client_reference_id": account_id,
            "customer": customer_id,
            "payment_intent": "pi_test_pack_cleanup",
            "metadata": {
                "billing_kind": "credit_pack",
                "pack_schema_version": "1",
                "product_line": e2e_stripe.E2E_PRODUCT_LINE,
                "account_id": account_id,
                "credit_pack_order_id": order_id,
                "pack_key": "boost-100",
                "pack_credits": "100",
                "price_amount": "1500",
                "currency": "usd",
                "expires_days": "365",
                "lookup_key": "ent_pack_boost-100",
            },
        }
    )
    intent = _StripeObject(
        {
            "id": "pi_test_pack_cleanup",
            "livemode": False,
            "customer": customer_id,
            "latest_charge": "ch_test_pack_cleanup",
            "status": "succeeded",
            "amount": 1500,
            "amount_received": 1500,
            "currency": "usd",
            "metadata": {
                "billing_kind": "credit_pack",
                "pack_schema_version": "1",
                "product_line": e2e_stripe.E2E_PRODUCT_LINE,
                "account_id": account_id,
                "credit_pack_order_id": order_id,
                "pack_key": "boost-100",
                "pack_credits": "100",
                "price_amount": "1500",
                "currency": "usd",
                "expires_days": "365",
                "lookup_key": "ent_pack_boost-100",
            },
        }
    )
    charge = _StripeObject(
        {
            "id": "ch_test_pack_cleanup",
            "livemode": False,
            "customer": customer_id,
            "payment_intent": "pi_test_pack_cleanup",
            "amount": 1500,
            "currency": "usd",
            "amount_refunded": 0,
            "refunded": False,
        }
    )
    return session, intent, charge


def test_pack_cleanup_refunds_only_after_full_session_payment_lineage_verification(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_placeholder")
    session, intent, charge = _pack_cleanup_objects()
    monkeypatch.setattr(
        e2e_stripe.stripe.checkout.Session,
        "retrieve",
        lambda candidate, **kwargs: session,
    )
    monkeypatch.setattr(
        e2e_stripe.stripe.PaymentIntent,
        "retrieve",
        lambda candidate, **kwargs: intent,
    )
    monkeypatch.setattr(
        e2e_stripe.stripe.Charge,
        "retrieve",
        lambda candidate, **kwargs: charge,
    )
    refund_calls: list[dict[str, Any]] = []

    def create_refund(**kwargs: Any) -> _StripeObject:
        refund_calls.append(kwargs)
        charge.payload["amount_refunded"] = charge.payload["amount"]
        charge.payload["refunded"] = True
        return _StripeObject({"id": "re_test_pack_cleanup"})

    monkeypatch.setattr(e2e_stripe.stripe.Refund, "create", create_refund)
    resolved = e2e_stripe._close_run_owned_pack_payment(
        account_id="8dd9153e-3629-4418-817c-b4b21d1637df",
        order_id="4dff1f2c-6543-4017-bb9d-6cbb75d01fb8",
        session_id="cs_test_pack_cleanup",
        payment_intent_id="pi_test_pack_cleanup",
        charge_id="ch_test_pack_cleanup",
        customer_id="cus_test_pack_cleanup",
    )

    assert resolved["charge_id"] == "ch_test_pack_cleanup"
    assert len(refund_calls) == 1
    assert refund_calls[0]["charge"] == "ch_test_pack_cleanup"
    assert refund_calls[0]["amount"] == 1500
    assert refund_calls[0]["idempotency_key"] == (
        "browser-pack-cleanup:4dff1f2c-6543-4017-bb9d-6cbb75d01fb8"
    )


def test_pack_cleanup_refuses_metadata_drift_before_any_refund(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_placeholder")
    session, intent, charge = _pack_cleanup_objects()
    session.payload["metadata"]["account_id"] = "not-the-run-account"
    monkeypatch.setattr(
        e2e_stripe.stripe.checkout.Session,
        "retrieve",
        lambda candidate, **kwargs: session,
    )
    monkeypatch.setattr(
        e2e_stripe.stripe.PaymentIntent,
        "retrieve",
        lambda candidate, **kwargs: intent,
    )
    monkeypatch.setattr(
        e2e_stripe.stripe.Charge,
        "retrieve",
        lambda candidate, **kwargs: charge,
    )
    monkeypatch.setattr(
        e2e_stripe.stripe.Refund,
        "create",
        lambda **kwargs: pytest.fail("ownership drift must stop before refund"),
    )

    with pytest.raises(RuntimeError, match="unowned credit-pack Session"):
        e2e_stripe._close_run_owned_pack_payment(
            account_id="8dd9153e-3629-4418-817c-b4b21d1637df",
            order_id="4dff1f2c-6543-4017-bb9d-6cbb75d01fb8",
            session_id="cs_test_pack_cleanup",
            payment_intent_id="pi_test_pack_cleanup",
            charge_id="ch_test_pack_cleanup",
            customer_id="cus_test_pack_cleanup",
        )


@pytest.mark.asyncio
async def test_normal_cleanup_discovers_unattached_pack_session_by_exact_order(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_placeholder")
    account_id = "8dd9153e-3629-4418-817c-b4b21d1637df"
    order_id = "4dff1f2c-6543-4017-bb9d-6cbb75d01fb8"
    customer_id = "cus_test_unattached_pack"
    connection = _ManifestConnection(
        {
            "id": account_id,
            "stripe_customer_id": None,
            "stripe_subscription_id": None,
            "session_id": None,
            "credit_pack_order_id": order_id,
            "credit_pack_checkout_session_id": None,
            "credit_pack_payment_intent_id": None,
            "credit_pack_charge_id": None,
        }
    )
    pack_session = _StripeObject(
        {
            "id": "cs_test_unattached_pack",
            "livemode": False,
            "mode": "payment",
            "status": "open",
            "client_reference_id": account_id,
            "customer": customer_id,
            "payment_intent": None,
            "metadata": {
                "billing_kind": "credit_pack",
                "pack_schema_version": "1",
                "product_line": e2e_stripe.E2E_PRODUCT_LINE,
                "account_id": account_id,
                "credit_pack_order_id": order_id,
                "pack_key": "boost-100",
                "pack_credits": "100",
                "price_amount": "1500",
                "currency": "usd",
                "expires_days": "365",
                "lookup_key": "ent_pack_boost-100",
            },
        }
    )
    wrong_order_session = _StripeObject(
        {
            **pack_session.payload,
            "id": "cs_test_wrong_order",
            "metadata": {
                **pack_session.payload["metadata"],
                "credit_pack_order_id": "11111111-1111-4111-8111-111111111111",
            },
        }
    )
    wrong_account_session = _StripeObject(
        {
            **pack_session.payload,
            "id": "cs_test_wrong_account",
            "client_reference_id": "22222222-2222-4222-8222-222222222222",
            "metadata": {
                **pack_session.payload["metadata"],
                "account_id": "22222222-2222-4222-8222-222222222222",
            },
        }
    )
    customer = _StripeObject({"id": customer_id, "livemode": False, "deleted": False})
    list_calls = 0

    async def connect(*args: Any, **kwargs: Any) -> _ManifestConnection:
        return connection

    def list_sessions(*args: Any, **kwargs: Any) -> _StripePage:
        nonlocal list_calls
        list_calls += 1
        return _StripePage([wrong_order_session, wrong_account_session, pack_session])

    monkeypatch.setattr(e2e_stripe.asyncpg, "connect", connect)
    monkeypatch.setattr(e2e_stripe.stripe.checkout.Session, "list", list_sessions)
    monkeypatch.setattr(
        e2e_stripe.stripe.checkout.Session,
        "retrieve",
        lambda candidate, **kwargs: (
            pack_session
            if candidate == "cs_test_unattached_pack"
            else pytest.fail("unexpected Checkout Session identity")
        ),
    )
    monkeypatch.setattr(
        e2e_stripe.stripe.Customer,
        "retrieve",
        lambda candidate, **kwargs: (
            customer if candidate == customer_id else pytest.fail("unexpected Customer identity")
        ),
    )

    await e2e_stripe.cleanup_account(
        SimpleNamespace(database_url="postgresql://test", external_ref="browser-e2e-subject")
    )

    assert connection.closed
    assert list_calls == 1
    assert pack_session.expire_calls == 1
    assert wrong_order_session.expire_calls == 0
    assert wrong_account_session.expire_calls == 0
    assert customer.delete_calls == 1


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
            "credit_pack_order_id": "9d00ab21-b91f-4ec3-8253-5f8d32fce89e",
            "credit_pack_checkout_session_id": "cs_test_pack_owned",
            "credit_pack_payment_intent_id": "pi_test_pack_owned",
            "credit_pack_charge_id": "ch_test_pack_owned",
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
    assert written["credit_pack_order_id"] == "9d00ab21-b91f-4ec3-8253-5f8d32fce89e"
    assert written["credit_pack_checkout_session_id"] == "cs_test_pack_owned"
    assert written["credit_pack_payment_intent_id"] == "pi_test_pack_owned"
    assert written["credit_pack_charge_id"] == "ch_test_pack_owned"
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
