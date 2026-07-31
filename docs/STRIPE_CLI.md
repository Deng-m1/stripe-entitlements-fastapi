# Stripe CLI and test-mode runbook

## Guardrails

Use test mode while developing. Never paste keys into shell history on shared machines;
prefer an ignored local `.env` or secret manager. Commands use placeholders only.

Before any automated lifecycle test:

```bash
case "$STRIPE_SECRET_KEY" in
  sk_test_*) echo "test mode" ;;
  *) echo "refusing non-test key"; exit 1 ;;
esac
```

The automated real suite performs the same check before any network call. Manual commands
must follow it too.

## Request version versus Event snapshot version

Do not reuse one label for two Stripe contracts:

- `STRIPE_API_VERSION` is sent with outbound SDK requests. Current code targets
  `2026-06-24.dahlia`.
- Webhook payloads contain Event `api_version` from the endpoint/account snapshot.
  `STRIPE_WEBHOOK_API_VERSION` must equal that actual value.

The currently observed test-account Events reported `2025-12-15.clover`. This does not
change the request version, and the request version does not transform those Events.
Inspect an actual Event before setting the webhook variable:

```bash
stripe events list --limit 5
stripe events retrieve evt_REPLACE_ME
```

Read the top-level `api_version` without copying the full payload into logs or issues.
The processor stores a mismatch as `webhook_contract_mismatch` and does not apply it.

## Local forwarding

```bash
stripe login
stripe listen --events \\
checkout.session.completed,checkout.session.expired,invoice.paid,invoice.payment_failed,customer.subscription.updated,customer.subscription.deleted,charge.refunded,charge.dispute.created \\
--forward-to http://127.0.0.1:8000/webhooks/stripe
```

`stripe listen` prints a temporary signing secret. Put it in the ignored local `.env`,
restart the API, and do not commit it.

Basic transport/signature smoke:

```bash
stripe trigger invoice.paid
```

The canned object has no repository account/intent. A durable unknown-account incident is
expected. This proves forwarding/signature transport, not entitlement correctness.

## Inspect and resend safely

```bash
stripe events list --limit 5
stripe events resend evt_REPLACE_ME \\
  --webhook-endpoint we_REPLACE_ME
```

Do not paste raw Event JSON into public issues. Redact customer, Subscription, Invoice,
PaymentIntent, Charge, request, email and payment-method data. Hosted invoice URLs and
confirmation/client secrets are sensitive even though they are not `sk_*` keys.

Resending a committed Event ID should return duplicate and must not create another grant.
Reconciliation, not Event editing, repairs a genuinely missing entitlement.

## Catalog and Portal

Bootstrap test-mode Products, Prices and the dedicated Portal configuration:

```bash
uv run python scripts/bootstrap_stripe.py
uv run python scripts/bootstrap_stripe.py --verify-only
```

The Portal policy intentionally disables subscription price updates and permits
cancellation only at period end. Plan changes must pass through the authenticated
preview/confirm API so annual funding, invoice preview and durable intent cannot be
bypassed.

## Test Clocks: exact boundary

Test Clocks are useful for renewal and boundary testing, but the current automated real
test only:

1. creates an isolated clock;
2. advances it by one hour;
3. polls until `ready` at the target time;
4. deletes it.

It does not attach a full subscription lifecycle and does not verify renewals, annual
slots, cancellation, declines, plan transitions, Schedules or webhook order. Do not cite
it as such.

For future manual/Test Clock expansion, create the Customer on the clock before attaching
payment methods/subscriptions, advance in bounded steps, wait for `ready` every time, and
assert the resulting webhook-projected account—not just Stripe object state.

## Manual plan-transition evidence

The automated real suite now covers a full-price/no-proration monthly upgrade
through paid Event projection and an annual-origin two-phase Schedule. The
remaining 2026-07-31 manual evidence set contains:

- `PY → UM` invoice preview at negative $204, which remains period-end;
- a declined immediate change with old SKU retained, Subscription still active, open
  latest Invoice, hosted recovery URL and confirmation secret.

These observations are not CLI commands to run blindly and are not part of automated CI.
Use isolated test customers and record both request/Event versions, starting/target
lookup keys, preview totals, final Event types and cleanup. Never commit raw identifiers.

## Production cutover

Test and live mode do not share Products, Prices, Portal configurations, webhook
endpoints, Events or signing secrets.

1. run `bootstrap_stripe.py --allow-live` with an explicitly approved live key;
2. run `--verify-only` and save redacted output in the private release record;
3. create a new live webhook endpoint with only the supported event types;
4. inspect a live endpoint Event snapshot and set `STRIPE_WEBHOOK_API_VERSION` to it;
5. configure the new live signing secret independently;
6. run a low-risk end-to-end Checkout, Portal cancel-at-period-end and recovery test;
7. verify the account changes only after signed webhook projection;
8. monitor unresolved incidents and webhook 5xx before increasing traffic.

Never use `stripe trigger` or the automated object-creation suite with a live key.
