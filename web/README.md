# Billing frontend reference

This directory is a minimal Next.js App Router UI for the repository's Stripe
entitlement model. It consumes the backend's catalog, account, Checkout, Portal,
and preview/confirm endpoints through a replaceable authentication adapter. It renders
three monthly/yearly tiers, positive same-currency annual savings, and the server's two
complete 6 × 6 transition policies: `full_period_reset` and `prorated_delta`.

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

## Public SEO configuration

The reference site includes a server-rendered project landing page, indexable initial
pricing catalog, canonical/Open Graph/Twitter metadata, JSON-LD, `robots.txt`,
`sitemap.xml`, a manifest, and generated social cards. Indexing is fail-closed: previews,
staging, and local development remain `noindex` unless the canonical production
deployment sets both values:

```env
NEXT_PUBLIC_SITE_URL=https://billing.example.com
NEXT_PUBLIC_ALLOW_INDEXING=true
```

The site URL must be an HTTPS origin without a path, credentials, query, or fragment.
`/account` and `/billing/*` always remain `noindex`. The bundled server-rendered catalog
comes from `reference-catalog.json` through `lib/reference-catalog.ts`; keep the JSON
synchronized with `../plans.toml` when changing example prices or entitlements. The
backend suite enforces that equality. See the [SEO runbook](../docs/SEO.md) for the route
policy and deployment checks.

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
  "transition_policy": "full_period_reset",
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
  "transition_policy": "full_period_reset",
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
    "transition_policy": "full_period_reset",
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

Request: `{"plan_key":"pro","interval":"month"}`.

```json
{
  "preview_id": "opaque-short-lived-id",
  "current_plan_key": "starter",
  "current_interval": "month",
  "target_plan_key": "pro",
  "target_interval": "month",
  "timing": "immediate",
  "transition_policy": "prorated_delta",
  "settlement_mode": "current_period_prorated_delta",
  "effective_at": "2026-07-31T12:00:00Z",
  "currency": "USD",
  "amount_due_now": 1500,
  "credit_applied": 950,
  "entitlement_credit_delta": 700,
  "next_invoice_amount": 4900
}
```

`timing`, `transition_policy`, `settlement_mode`, and all amounts are
server-authoritative. `new_period_full_price` means one independently funded target
period. `current_period_prorated_delta` means the current period remains unchanged,
`credit_applied` is the unused source-plan cash credit, and
`entitlement_credit_delta` is the fixed product-credit difference. Confirmation may
charge the payment method or require authentication; entitlements still wait for paid
Invoice webhook projection. The backend compare-and-set binds the immediate result's
exact settlement Invoice to the intent, so a delayed failure from an older Invoice
cannot hijack the new UI state. If the paid webhook finishes first, confirm may return a
conflict rather than falsely claiming synchronous success; only a later authenticated
account read is entitlement truth. A `period_end` preview says no charge today and
preserves current benefits until `effective_at`.

Policy note: every non-noop change from a yearly plan is period-end under both
templates. The delta template also defers every interval change and downgrade; only a
higher monthly tier remaining monthly is eligible. Unsupported tax, discount, credit
note, customer balance, and Invoice line shapes fail closed. The backend returns that
decision explicitly; the browser never reconstructs it from tier order or price.

### `POST /api/billing/change/confirm`

Request: `{"preview_id":"opaque-short-lived-id"}`.

Period-end or completed response:

```json
{
  "status": "confirmed",
  "timing": "period_end",
  "transition_policy": "prorated_delta",
  "target_plan_key": "starter",
  "target_interval": "month"
}
```

An immediate update using Stripe `pending_if_incomplete` may require payment
recovery/SCA. The UI keeps showing the old account entitlements. When a confirmation
secret is present it first uses Stripe.js in memory; a Stripe-hosted Invoice URL is the
fallback recovery CTA when no client secret is returned:

```json
{
  "status": "payment_required",
  "timing": "immediate",
  "transition_policy": "prorated_delta",
  "target_plan_key": "pro",
  "target_interval": "month",
  "payment_url": "https://invoice.stripe.com/..."
}
```

Client-secret-first response:

```json
{
  "status": "action_required",
  "timing": "immediate",
  "transition_policy": "prorated_delta",
  "target_plan_key": "pro",
  "target_interval": "month",
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

The mock-data public UI can be recorded without Stripe or PostgreSQL from the repository
root:

```bash
PROMO_STEP_PAUSE_MS=1400 scripts/run_promo_ui.sh
```

The Playwright promo config is excluded from Vitest and writes only to ignored
`test-results/`. Use the repository-level FFmpeg/Tesseract workflow in
[`docs/DEMO_VIDEO.md`](../docs/DEMO_VIDEO.md) to combine it with a redacted real
Stripe test-mode lifecycle; do not publish the raw page videos.

The real hosted-Checkout browser gate is deliberately separate from default tests. It
requires a fresh account, real Stripe test mode, signed webhook delivery, and explicit
opt-in:

```bash
E2E_RUN_REAL_STRIPE=1 \
E2E_STRIPE_MODE=test \
E2E_BASE_URL=http://127.0.0.1:3000 \
E2E_BACKEND_URL=http://127.0.0.1:8000 \
E2E_DATABASE_URL="$TEST_DATABASE_READ_ONLY_URL" \
E2E_EXTERNAL_REF=browser-e2e-subject \
npm run test:e2e:stripe
```

It submits a real decline, then completes test 3DS in the same Checkout Session, and
accepts success only after the browser observes the webhook-projected account. The
default upgrade fixture then requires a second Stripe.js SCA flow before the settlement
paid Event can project Pro/Monthly/1,000. It stops before card entry unless the hosted
Session is `cs_test_`. The full runner keeps the Stripe test key and database DSN in the
Playwright Node helper, starts Next.js without them, and removes them from Chromium's
process environment. Remote existing-stack runs additionally require a private mode-
`0600` `E2E_STORAGE_STATE` for the same one-run subject as `E2E_EXTERNAL_REF`. Prefer
the isolated full-stack runner and follow all prerequisites in
[the browser E2E runbook](../docs/BROWSER_E2E.md).

Current `0.2.1` release-candidate evidence recorded on 2026-08-18 is 102 passing
RTL/Vitest tests, plus passing lint, typecheck, production build, production npm audit,
and complete npm audit. It covers annual pricing math, both transition policies,
reusable billing intents, Checkout/Portal redirect boundaries, strict Stripe.js result
validation, webhook polling, HTTP timeout/error sanitization, browser secret isolation,
security headers, SEO configuration, server-rendered plans, JSON-LD, and fail-closed
indexing/demo builds. Both real-browser policies also passed through explicit Stripe CLI
signed forwarding: each completed decline, Checkout 3DS, upgrade SCA, Starter/300 and
Pro/1,000 projection, seven related and zero unrelated Events, exact three-essential-
Event binding, and strict cleanup. The latest separate temporary-endpoint evidence remains
the 2026-08-02 dual-policy run. All browser results remain test-mode evidence, not live-
production proof.
