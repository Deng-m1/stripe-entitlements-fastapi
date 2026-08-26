from __future__ import annotations

import json

from stripe_entitlements.event_audit import redacted_event_snapshot


def test_event_audit_redacts_secrets_pii_urls_and_unknown_metadata() -> None:
    event = {
        "id": "evt_audit",
        "type": "invoice.payment_failed",
        "api_version": "2026-06-24.dahlia",
        "_remote_verified": True,
        "data": {
            "object": {
                "id": "in_audit",
                "customer_email": "person@example.test",
                "customer_name": "Person Name",
                "customer_address": {"line1": "private street"},
                "confirmation_secret": {"client_secret": "pi_123_secret_abc"},
                "hosted_invoice_url": "https://invoice.stripe.test/private",
                "invoice_pdf": "https://invoice.stripe.test/private.pdf",
                "url": "https://checkout.stripe.com/private",
                "description": "contact embedded@example.test and use pi_123_secret_embedded",
                "support_note": "open https://invoice.stripe.test/embedded to recover",
                "payment_intent_client_secret": "pi_456_secret_nested",
                "REQUEST_URL": "https://example.test/uppercase-key",
                "request": {"idempotency_key": "user-provided-private-key"},
                "metadata": {
                    "account_id": "00000000-0000-0000-0000-000000000001",
                    "product_line": "example-entitlements",
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
    assert obj["customer_email"] == "[redacted]"
    assert obj["customer_name"] == "[redacted]"
    assert obj["customer_address"] == "[redacted]"
    assert obj["confirmation_secret"] == "[redacted]"
    assert obj["hosted_invoice_url"] == "[redacted]"
    assert obj["invoice_pdf"] == "[redacted]"
    assert obj["url"] == "[redacted]"
    assert obj["description"] == "[redacted]"
    assert obj["support_note"] == "[redacted]"
    assert obj["payment_intent_client_secret"] == "[redacted]"
    assert obj["REQUEST_URL"] == "[redacted]"
    assert obj["request"]["idempotency_key"] == "[redacted]"
    assert obj["metadata"] == {
        "account_id": "00000000-0000-0000-0000-000000000001",
        "product_line": "example-entitlements",
        "plan_key": "[redacted]",
        "claim_token": "[redacted]",
        "free_form_note": "[redacted]",
    }
    assert "_resolved_lookup_key" not in obj["lines"]["data"][0]
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
    ):
        assert forbidden not in encoded
