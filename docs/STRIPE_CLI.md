# Stripe CLI runbook

## Guardrails

Use test mode while developing. Never paste keys into shell history on shared machines;
prefer a local ignored `.env` or secret manager. Commands in this document use visible
placeholders only.

Confirm that a key is test mode before any automated lifecycle test:

```bash
case "$STRIPE_SECRET_KEY" in
  sk_test_*) echo "test mode" ;;
  *) echo "refusing non-test key"; exit 1 ;;
esac
```

## Login and local forwarding

```bash
stripe login
stripe listen --events \
checkout.session.completed,checkout.session.expired,invoice.paid,invoice.payment_failed,customer.subscription.updated,customer.subscription.deleted,charge.refunded,charge.dispute.created \
--forward-to http://127.0.0.1:8000/webhooks/stripe
```

`stripe listen` prints a temporary signing secret. Put it in `.env` as
`STRIPE_WEBHOOK_SECRET`, restart the API, and do not commit it.

Basic transport/signature smoke test:

```bash
stripe trigger invoice.paid
```

The generated event is not associated with a repository account; an incident is expected.
Use the real test suite for entitlement assertions.

## Inspect delivery without leaking customer data

```bash
stripe events list --limit 5
stripe events resend evt_REPLACE_ME \
  --webhook-endpoint we_REPLACE_ME
```

Do not paste raw event JSON into public issues. Redact customer IDs, emails, invoice IDs,
payment method details, request IDs, and metadata.

## Test Clocks

Test Clocks are appropriate for renewal, annual boundaries, cancellation, and payment
failure recovery. Objects attached to a Test Clock have lifecycle restrictions: create
the Customer on the clock first, then attach payment methods and subscriptions. Advance
the clock in bounded steps and wait for `status=ready` before the next step.

The repository real suite uses isolated test objects and polls Stripe instead of assuming
immediate webhook order. Never encode an order expectation into product logic.

## Production cutover

Test and live mode do not share Products, Prices, Portal configurations, webhook
endpoints, events, or signing secrets. Repeat catalog bootstrap and verification with a
live key as a deliberate release step, then create the live endpoint and configure its
new `whsec_` value in the production service.
