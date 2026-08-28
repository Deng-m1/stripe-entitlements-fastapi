from __future__ import annotations

import json

from stripe_entitlements.event_audit import redacted_event_snapshot


def test_event_audit_persists_only_minimal_allowlisted_operational_fields() -> None:
    event = {
        "id": "evt_audit",
        "type": "invoice.payment_failed",
        "api_version": "2026-06-24.dahlia",
        "_remote_verified": True,
        "data": {
            "object": {
                "id": "in_audit",
                "client_reference_id": "00000000-0000-4000-8000-000000000003",
                "currency": "usd",
                "customer_email": "person@example.test",
                "customer_name": "Person Name",
                "customer_address": {"line1": "private street"},
                "confirmation_secret": {"client_secret": "pi_123_secret_abc"},
                "hosted_invoice_url": "https://invoice.stripe.test/private",
                "invoice_pdf": "https://invoice.stripe.test/private.pdf",
                "url": "https://checkout.stripe.com/private",
                "free_text_note": ("contact embedded@example.test and use pi_123_secret_embedded"),
                "support_note": "open https://invoice.stripe.test/embedded to recover",
                "payment_intent_client_secret": "pi_456_secret_nested",
                "REQUEST_URL": "https://example.test/uppercase-key",
                "customer_tax_ids": [{"type": "eu_vat", "value": "DE123456789"}],
                "custom_fields": [{"name": "Customer", "value": "Alice Example"}],
                "description": "Alice Consulting LLC",
                "request": {"idempotency_key": "user-provided-private-key"},
                "metadata": {
                    "account_id": "00000000-0000-0000-0000-000000000001",
                    "product_line": "example-entitlements",
                    "billing_kind": "credit_pack",
                    "pack_schema_version": "1",
                    "credit_pack_order_id": "00000000-0000-4000-8000-000000000002",
                    "pack_key": "boost-100",
                    "pack_credits": "100",
                    "price_amount": "1500",
                    "currency": "usd",
                    "expires_days": "365",
                    "lookup_key": "ent_pack_boost-100",
                    "plan_key": "note-sk_test_embeddedsecret",
                    "claim_token": "private-claim-token",
                    "free_form_note": "private note",
                },
                "lines": {
                    "data": [
                        {
                            "_resolved_lookup_key": "ent_starter_month",
                            "price": {"lookup_key": "ent_starter_month"},
                        }
                    ]
                },
            }
        },
    }

    snapshot = redacted_event_snapshot(event)
    encoded = json.dumps(snapshot, sort_keys=True)
    obj = snapshot["data"]["object"]
    assert snapshot["id"] == "evt_audit"
    assert "_remote_verified" not in snapshot
    assert obj["metadata"] == {
        "account_id": "00000000-0000-0000-0000-000000000001",
        "product_line": "example-entitlements",
        "billing_kind": "credit_pack",
        "pack_schema_version": "1",
        "credit_pack_order_id": "00000000-0000-4000-8000-000000000002",
        "pack_key": "boost-100",
        "pack_credits": "100",
        "price_amount": "1500",
        "currency": "usd",
        "expires_days": "365",
        "lookup_key": "ent_pack_boost-100",
    }
    assert obj["client_reference_id"] == "00000000-0000-4000-8000-000000000003"
    assert obj["currency"] == "usd"
    assert set(obj) == {"id", "client_reference_id", "currency", "metadata"}
    for forbidden in (
        "person@example.test",
        "Person Name",
        "private street",
        "pi_123_secret_abc",
        "private-claim-token",
        "private note",
        "checkout.stripe.com",
        "embedded@example.test",
        "pi_123_secret_embedded",
        "invoice.stripe.test/embedded",
        "pi_456_secret_nested",
        "user-provided-private-key",
        "sk_test_embeddedsecret",
        "DE123456789",
        "Alice Example",
        "Alice Consulting LLC",
    ):
        assert forbidden not in encoded


def test_event_audit_rejects_free_text_even_under_allowlisted_metadata_keys() -> None:
    snapshot = redacted_event_snapshot(
        {
            "id": "evt_safe",
            "type": "payment_intent.succeeded",
            "livemode": False,
            "data": {
                "object": {
                    "id": "pi_safe",
                    "object": "payment_intent",
                    "status": "succeeded",
                    "customer": {"id": "cus_safe", "name": "Private Person"},
                    "metadata": {
                        "account_id": "00000000-0000-4000-8000-000000000001",
                        "plan_key": "Alice",
                        "product_line": "sk_test_embeddedsecret",
                        "currency": "usd",
                    },
                    "description": "Private Consulting LLC",
                }
            },
        }
    )

    assert snapshot == {
        "id": "evt_safe",
        "type": "payment_intent.succeeded",
        "livemode": False,
        "data": {
            "object": {
                "id": "pi_safe",
                "customer": "cus_safe",
                "object": "payment_intent",
                "status": "succeeded",
                "metadata": {
                    "account_id": "00000000-0000-4000-8000-000000000001",
                    "currency": "usd",
                },
            }
        },
    }
