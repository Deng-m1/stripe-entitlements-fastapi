import { describe, expect, it } from "vitest";

import { redactedEventSnapshot } from "../../src/event-audit.js";

describe("redacted Stripe Event audit snapshot", () => {
  it("persists every explicitly allowlisted operational field", () => {
    const snapshot = redactedEventSnapshot({
      id: "evt_audit",
      object: "event",
      type: "invoice.paid",
      api_version: "2026-06-24.dahlia",
      livemode: false,
      created: 1_785_578_400,
      data: {
        object: {
          id: "in_audit",
          customer: { id: "cus_audit", email: "private@example.test" },
          subscription: "sub_audit",
          invoice: { id: "in_parent" },
          payment_intent: "pi_audit",
          charge: { id: "ch_audit" },
          latest_charge: "ch_latest",
          object: "invoice",
          status: "paid",
          payment_status: "paid",
          mode: "subscription",
          billing_reason: "subscription_cycle",
          client_reference_id: "00000000-0000-4000-8000-000000000003",
          currency: "usd",
          livemode: false,
          paid: true,
          refunded: false,
          created: 1_785_578_399,
          amount: 1900,
          amount_due: 1900,
          amount_paid: 1900,
          amount_received: 1900,
          amount_refunded: 0,
          metadata: {
            account_id: "00000000-0000-0000-0000-000000000001",
            billing_kind: "credit_pack",
            credit_pack_order_id: "00000000-0000-4000-8000-000000000002",
            currency: "usd",
            expires_days: "365",
            lookup_key: "ent_pack_boost-100",
            pack_credits: "100.125",
            pack_key: "boost-100",
            pack_schema_version: "1",
            plan: "starter",
            plan_key: "starter",
            plan_interval: "month",
            price_amount: "1500",
            product_line: "example-entitlements",
            transition_policy: "prorated_delta",
          },
        },
      },
    });

    expect(snapshot).toEqual({
      id: "evt_audit",
      object: "event",
      type: "invoice.paid",
      api_version: "2026-06-24.dahlia",
      livemode: false,
      created: 1_785_578_400,
      data: {
        object: {
          id: "in_audit",
          customer: "cus_audit",
          subscription: "sub_audit",
          invoice: "in_parent",
          payment_intent: "pi_audit",
          charge: "ch_audit",
          latest_charge: "ch_latest",
          object: "invoice",
          status: "paid",
          payment_status: "paid",
          mode: "subscription",
          billing_reason: "subscription_cycle",
          client_reference_id: "00000000-0000-4000-8000-000000000003",
          currency: "usd",
          livemode: false,
          paid: true,
          refunded: false,
          created: 1_785_578_399,
          amount: 1900,
          amount_due: 1900,
          amount_paid: 1900,
          amount_received: 1900,
          amount_refunded: 0,
          metadata: {
            account_id: "00000000-0000-0000-0000-000000000001",
            billing_kind: "credit_pack",
            credit_pack_order_id: "00000000-0000-4000-8000-000000000002",
            currency: "usd",
            expires_days: "365",
            lookup_key: "ent_pack_boost-100",
            pack_credits: "100.125",
            pack_key: "boost-100",
            pack_schema_version: "1",
            plan: "starter",
            plan_key: "starter",
            plan_interval: "month",
            price_amount: "1500",
            product_line: "example-entitlements",
            transition_policy: "prorated_delta",
          },
        },
      },
    });
  });

  it("strips PII, free text, URLs, claims, client secrets, and recursive Stripe data", () => {
    const event = {
      id: "evt_audit",
      type: "invoice.payment_failed",
      _remote_verified: true,
      request: { idempotency_key: "private-key" },
      data: {
        object: {
          id: "in_audit",
          client_reference_id: "00000000-0000-4000-8000-000000000003",
          currency: "usd",
          customer_email: "person@example.test",
          customer_name: "Person Name",
          customer_address: { line1: "private street" },
          confirmation_secret: { client_secret: "pi_123_secret_abc" },
          hosted_invoice_url: "https://invoice.stripe.test/private",
          invoice_pdf: "https://invoice.stripe.test/private.pdf",
          url: "https://checkout.stripe.com/private",
          free_text_note:
            "contact embedded@example.test and use pi_123_secret_embedded",
          support_note: "open https://invoice.stripe.test/embedded to recover",
          payment_intent_client_secret: "pi_456_secret_nested",
          customer_tax_ids: [{ type: "eu_vat", value: "DE123456789" }],
          custom_fields: [{ name: "Customer", value: "Alice Example" }],
          description: "Alice Consulting LLC",
          request: { idempotency_key: "user-provided-private-key" },
          metadata: {
            account_id: "00000000-0000-0000-0000-000000000001",
            product_line: "example-entitlements",
            billing_kind: "credit_pack",
            pack_schema_version: "1",
            credit_pack_order_id: "00000000-0000-4000-8000-000000000002",
            pack_key: "boost-100",
            pack_credits: "100",
            price_amount: "1500",
            currency: "usd",
            expires_days: "365",
            lookup_key: "ent_pack_boost-100",
            plan_key: "note-sk_test_embeddedsecret",
            claim_token: "private-claim-token",
            free_form_note: "private note",
          },
          lines: { data: [{ price: { lookup_key: "ent_starter_month" } }] },
        },
      },
    };
    const snapshot = redactedEventSnapshot(event);
    expect(snapshot).toEqual({
      id: "evt_audit",
      type: "invoice.payment_failed",
      data: {
        object: {
          id: "in_audit",
          client_reference_id: "00000000-0000-4000-8000-000000000003",
          currency: "usd",
          metadata: {
            account_id: "00000000-0000-0000-0000-000000000001",
            billing_kind: "credit_pack",
            credit_pack_order_id: "00000000-0000-4000-8000-000000000002",
            currency: "usd",
            expires_days: "365",
            lookup_key: "ent_pack_boost-100",
            pack_credits: "100",
            pack_key: "boost-100",
            pack_schema_version: "1",
            price_amount: "1500",
            product_line: "example-entitlements",
          },
        },
      },
    });
    const encoded = JSON.stringify(snapshot);
    for (const forbidden of [
      "person@example.test",
      "Person Name",
      "private street",
      "pi_123_secret_abc",
      "private-claim-token",
      "checkout.stripe.com",
      "embedded@example.test",
      "pi_456_secret_nested",
      "user-provided-private-key",
      "sk_test_embeddedsecret",
      "DE123456789",
      "Alice Example",
      "Alice Consulting LLC",
    ]) {
      expect(encoded).not.toContain(forbidden);
    }
  });

  it.each([
    ["sk_test_abc", "secret key"],
    ["rk_live_abc", "restricted key"],
    ["whsec_abc", "webhook secret"],
    ["pi_123_secret_abc", "client secret"],
    ["contains spaces", "free text"],
    ["https://example.test", "URL punctuation"],
    ["x".repeat(513), "oversized token"],
  ] as const)("drops a %s token", (token, _kind) => {
    void _kind;
    const snapshot = redactedEventSnapshot({
      id: token,
      type: token,
      data: { object: { id: token, status: token } },
    });
    expect(snapshot).toEqual({});
  });

  it("rejects malformed booleans, integers, UUIDs, currencies, and metadata", () => {
    const snapshot = redactedEventSnapshot({
      id: "evt_safe",
      livemode: 0,
      created: Number.MAX_SAFE_INTEGER + 1,
      data: {
        object: {
          id: "pi_safe",
          paid: 1,
          refunded: "false",
          amount: 1.5,
          amount_due: true,
          amount_paid: Number.MAX_SAFE_INTEGER + 1,
          client_reference_id: "not-a-uuid",
          currency: "USD",
          metadata: {
            account_id: "not-a-uuid",
            billing_kind: "subscription",
            currency: "USD",
            expires_days: "0",
            lookup_key: "rk_live_embedded",
            pack_credits: "01.0",
            pack_key: "Uppercase",
            pack_schema_version: "0",
            plan_key: "pi_123_secret_abc",
            plan_interval: "week",
            price_amount: "0",
            product_line: "sk_test_embedded",
            transition_policy: "unknown",
          },
        },
      },
    });
    expect(snapshot).toEqual({
      id: "evt_safe",
      data: { object: { id: "pi_safe" } },
    });
    expect(() => JSON.stringify(snapshot)).not.toThrow();
  });

  it.each([null, [], "event", 1])(
    "returns an empty object for a non-record Event %#",
    (event) => {
      expect(redactedEventSnapshot(event)).toEqual({});
    },
  );

  it("rejects array, prototype-bearing, and accessor-bearing nested records", () => {
    class StripeObject {
      public readonly id = "in_class";
    }
    expect(redactedEventSnapshot({ id: "evt_array", data: [] })).toEqual({
      id: "evt_array",
    });
    expect(
      redactedEventSnapshot({
        id: "evt_class",
        data: { object: new StripeObject() },
      }),
    ).toEqual({ id: "evt_class" });

    let accessed = false;
    const object = Object.defineProperty({}, "id", {
      enumerable: true,
      get: () => {
        accessed = true;
        return "in_accessor";
      },
    });
    expect(
      redactedEventSnapshot({ id: "evt_accessor", data: { object } }),
    ).toEqual({
      id: "evt_accessor",
    });
    expect(accessed).toBe(false);
  });
});
