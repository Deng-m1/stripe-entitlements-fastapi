# Billing frontend reference

This directory is a minimal Next.js App Router UI for the repository's Stripe
entitlement model. It consumes the backend's catalog, account, Checkout, Portal,
and preview/confirm endpoints through a replaceable authentication adapter.

## Run locally

```bash
cd web
npm ci
cp .env.example .env.local
npm run dev
```

Development defaults to an in-memory mock catalog/account. A yellow banner makes
that state visible. The mock uses the three plans and prices from `../plans.toml`;
plan identity and change direction use stable keys/order, never price comparison.
Mock mode and the browser-exposed demo Bearer adapter are rejected when
`NODE_ENV=production`.

For HTTP integration:

```env
NEXT_PUBLIC_BILLING_API_MODE=http
NEXT_PUBLIC_BILLING_API_BASE_URL=http://127.0.0.1:8000
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_REPLACE_ME
NEXT_PUBLIC_DEMO_BEARER_TOKEN=demo-local-token
```

`NEXT_PUBLIC_DEMO_BEARER_TOKEN` is only a replaceable local adapter. It is exposed
to browser JavaScript and is not production authentication. Production integration
must replace the composition in `lib/runtime.ts` with the host application's real
session/OIDC adapter. HTTP mode without an auth adapter fails explicitly.

Never put Stripe secret keys, webhook secrets, PaymentIntent client secrets, or
hosted invoice URLs in localStorage, analytics, logs, or source control.

## API contract

All monetary values are integer minor units. Plan identity uses `plan_key`;
interval is `month | year`. The frontend does not infer a plan or change timing
from a price.

`POST /api/checkout`, `POST /api/billing/portal`, and
`POST /api/billing/change/preview` require an `Idempotency-Key` header. The UI
creates one cryptographic UUID per user intent and reuses it after a failed
request or reload in the same tab. Only these non-secret keys are kept in
`sessionStorage`, and they are cleared after a completed handoff; callers using
the HTTP adapter directly may pass `{ idempotencyKey }`. Confirm uses the opaque
`preview_id`.

Browser redirects are validated again at the UI boundary. Internal success URLs
must remain same-origin. Checkout, Portal, and hosted invoice destinations must
either remain same-origin (mock mode) or use HTTPS on `stripe.com` or one of its
subdomains. Arbitrary HTTP(S) destinations are rejected.

### `GET /api/catalog`

```json
{
  "plans": [
    {
      "key": "starter",
      "name": "Starter",
      "description": "For individuals",
      "display_order": 10,
      "prices": {
        "month": {"currency": "USD", "unit_amount": 1900, "interval": "month"},
        "year": {"currency": "USD", "unit_amount": 13700, "interval": "year"}
      },
      "entitlements": [
        {
          "key": "monthly_credits",
          "label": "Credits per monthly grant",
          "value": 300,
          "unit": "credits"
        }
      ]
    }
  ]
}
```

Annual total, equivalent monthly price, and annual savings are derived only for
display from the two explicit price records. A savings label appears only when
currencies match and `year < month × 12`; otherwise the UI makes no discount
claim. This calculation never determines upgrade/downgrade direction.

### `GET /api/account`

```json
{
  "plan_key": "starter",
  "plan_interval": "month",
  "subscription_status": "active",
  "current_period_end": "2026-08-31T00:00:00Z",
  "credits": {
    "balance": 214,
    "grant_amount": 300,
    "next_grant_at": "2026-08-31T00:00:00Z"
  },
  "entitlements": [
    {
      "key": "monthly_credits",
      "label": "Credits per monthly grant",
      "value": 300,
      "unit": "credits"
    }
  ],
  "entitlements_enforceable": true,
  "pending_cancellation": null,
  "pending_change": {
    "target_plan_key": "pro",
    "target_interval": "year",
    "timing": "period_end",
    "effective_at": "2026-08-31T00:00:00Z"
  }
}
```

`pending_change` and `pending_cancellation` are nullable. A pending cancellation
targets `free`, remains period-end, and pauses plan-price changes until the user
resumes the subscription through the Portal. The response is the webhook-projected product
truth; redirects and successful POST responses are not entitlement proof.
The success page requires the expected catalog plan, interval, active status, and
`entitlements_enforceable=true`. Missing or attacker-controlled return parameters
never grant or display confirmed access. A future production contract should add
an opaque operation identifier if confirmation must be correlated to one exact
billing attempt rather than the expected webhook projection.

### `POST /api/checkout`

Request:

```json
{
  "plan_key": "starter",
  "interval": "month",
  "success_url": "http://localhost:3000/billing/success?expected_plan=starter&expected_interval=month",
  "cancel_url": "http://localhost:3000/pricing"
}
```

Response: `{"url":"https://checkout.stripe.com/..."}`.

The backend remains responsible for Checkout single-flight and for allowlisting
the return URL origin, fixed path, and the two expected-target query fields. It
must not accept arbitrary return paths or query parameters.

### `POST /api/billing/portal`

Request: `{"return_url":"http://localhost:3000/account"}`.

Response: `{"url":"https://billing.stripe.com/..."}`.

The backend must create a Portal Session only with its verified safe Portal
configuration. That configuration must keep subscription price changes disabled;
the Portal is limited to payment methods, invoices, and cancellation so plan
changes cannot bypass the server's safe transition matrix.

### `POST /api/billing/change/preview`

Request: `{"plan_key":"pro","interval":"year"}`.

```json
{
  "preview_id": "opaque-short-lived-id",
  "current_plan_key": "starter",
  "current_interval": "month",
  "target_plan_key": "pro",
  "target_interval": "year",
  "timing": "immediate",
  "effective_at": "2026-07-31T12:00:00Z",
  "currency": "USD",
  "amount_due_now": 35300,
  "credit_applied": 0,
  "next_invoice_amount": 35300
}
```

`timing` and all amounts are server-authoritative. An immediate preview is
accepted only for a full target invoice with zero cross-invoice proration and
zero customer-balance credit. Confirmation may charge the payment method or
require authentication; entitlements still wait for paid
invoice webhook projection. A `period_end` preview says no charge today and
preserves current benefits until `effective_at`.

Policy note: every non-noop change from a yearly plan is period-end, including
yearly-to-yearly tier upgrades. This avoids crossing annual-invoice funding and
later refund/dispute attribution. Monthly-origin cells marked immediate are only
preview-eligible; any nonzero old-invoice proration makes the server defer them.
The backend returns that decision explicitly; the browser never reconstructs it
from tier order or price.

### `POST /api/billing/change/confirm`

Request: `{"preview_id":"opaque-short-lived-id"}`.

Period-end or completed response:

```json
{
  "status": "confirmed",
  "timing": "period_end",
  "target_plan_key": "starter",
  "target_interval": "month"
}
```

An immediate update using Stripe `pending_if_incomplete` may require payment
recovery/SCA. Prefer a Stripe-hosted invoice when available. The UI keeps
showing the old account entitlements and presents an explicit payment CTA:

```json
{
  "status": "payment_required",
  "timing": "immediate",
  "target_plan_key": "pro",
  "target_interval": "year",
  "payment_url": "https://invoice.stripe.com/..."
}
```

The optional client-secret path is an enhancement when a hosted invoice URL is
not available:

```json
{
  "status": "action_required",
  "timing": "immediate",
  "target_plan_key": "pro",
  "target_interval": "year",
  "payment_client_secret": "short-lived value",
  "payment_confirmation_method": "confirm_payment"
}
```

The current backend emits `confirm_payment`; the adapter also supports
`confirm_card_payment` for a compatible host integration. The UI uses Stripe.js only when
`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` exists; otherwise it stops with an explicit
error. Client secrets stay in memory and are never persisted or logged.

After any immediate confirmation or hosted-payment return, the success page polls
`GET /api/account` until the expected target plan and interval are reported as
`active` with `entitlements_enforceable=true`. It never grants access from a
redirect or POST response alone.

## Checks

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

The verified 2026-07-31 RTL/Vitest run contains 47 passing tests covering annual
pricing math, immediate and period-end copy, Checkout, Portal, pending changes,
redirect allowlisting, missing SCA configuration, and webhook polling.
