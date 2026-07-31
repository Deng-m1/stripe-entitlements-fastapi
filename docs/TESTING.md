# Testing strategy and evidence boundary

The project separates deterministic local/PostgreSQL tests, opt-in automated Stripe
test-mode tests, manual Stripe observations, and production verification. Passing one
layer must not be described as passing another.

Latest verified 2026-07-31 result: 163 local/backend tests, 4 real Stripe
test-mode tests, and 47 frontend tests passed; the frontend production build and
production-dependency audit also passed.

## Default backend suite

`pytest -m "not real_stripe"` starts a disposable PostgreSQL 17 container on a
workspace-derived loopback port, applies all real SQL migrations, and removes the
container after the session. Each test truncates all correctness tables.

Coverage includes:

- plan catalog validation and the complete 6 × 6 transition matrix;
- raw webhook signature, livemode and Event snapshot-version rejection;
- authenticated catalog/account/Checkout/Portal/preview/confirm APIs;
- fail-closed production auth and explicit test-only demo auth;
- transaction rollback followed by successful retry;
- concurrent same-Event delivery and different Events targeting one grant;
- same-second paid/failed/updated/deleted ordering;
- refund/dispute before/after paid convergence and cumulative refund races;
- Checkout reservation, same-request replay, attach, expiration and stale Events;
- annual multi-worker grants, downtime slot jumps, mismatch and refund reduction;
- plan-change request replay, leases, preview fallback, Schedule and pending payment;
- paid-invoice authorization of plan changes and rejection without durable intent;
- product credit charges/refunds across entitlement epochs and revocation;
- incident deduplication and database constraints.

These tests use real PostgreSQL transactions and constraints but mocked Stripe responses.
They prove repository logic for the fixtures; they do not prove current Stripe network or
Dashboard behavior.

## Frontend suite

`web/` uses Vitest and React Testing Library. CI runs:

```bash
cd web
npm ci
npm audit --omit=dev
npm run lint
npm run typecheck
npm test
npm run build
```

The suite covers annual total/equivalent/savings display, explicit immediate and
period-end copy, all annual-origin policy cases (including `SY → PY/UY`), Checkout and
preview idempotency-key reuse, Portal, pending state, hosted-invoice recovery, missing
Stripe.js configuration, and polling until webhook-projected target state.

The frontend never tests or grants backend entitlement by itself.

## Automated real Stripe suite

Tests marked `real_stripe` make network calls only when `STRIPE_SECRET_KEY` starts with
`sk_test_`. Live keys fail before a network call. Objects are uniquely marked and cleanup
targets only objects created by that run.

As of 2026-07-31, the automated suite proves:

- creation of isolated real test-mode Products, monthly/yearly Prices, Customers and
  Subscriptions;
- retrieval/preparation of the real `invoice.paid` Event;
- projection of that paid $19 invoice to 300 credits in PostgreSQL;
- a real $9.50 partial refund and `charge.refunded` Event converging to 150 credits;
- outbound Dahlia preview/update calls for a real mid-cycle Starter Monthly →
  Pro Monthly full-price/no-proration change, followed by a separately versioned
  `invoice.paid` Event converging to Pro/1,000 credits in PostgreSQL;
- outbound Dahlia calls for a real Starter Yearly → Pro Yearly period-end
  change producing a two-phase contiguous Subscription Schedule with
  `end_behavior=release`;
- cleanup of the run's Subscription, Customer, Price and Product;
- creation of an isolated Test Clock, advance by one hour, polling until `ready`, and
  deletion.

The Test Clock test is a transport/object-state smoke only. It does **not** exercise a
renewal, annual credit slot, cancellation, payment decline or webhook forwarding
lifecycle. The two plan-change tests use direct Stripe test-mode requests and Event
polling, not Test Clock advancement or actual webhook delivery.

The real suite does not prove arbitrary Dashboard policy, delivery latency, production
tax/accounting settings, live mode, or unsupported invoice shapes.

Run it explicitly:

```bash
case "$STRIPE_SECRET_KEY" in
  sk_test_*) ;;
  *) echo "refusing non-test key"; exit 1 ;;
esac
uv run pytest -m real_stripe -v
```

## Manual Stripe test-mode evidence

The following observations were recorded manually on 2026-07-31 and are not replayed by
CI:

| Scenario | Observed result | What it supports |
| --- | --- | --- |
| `PY → UM` preview | negative $204 | why every annual-origin transition must defer |
| declined immediate change | old SKU and active Subscription remained; latest Invoice was open; hosted recovery URL and confirmation secret existed | `pending_if_incomplete` recovery and old-entitlement preservation |

Amounts are observations for that test account/time, not universal expected values. These
manual checks contain no committed customer, Event, Invoice or secret IDs and should be
rerun before a release that changes plan transitions or Stripe API version.

## Stripe version evidence

There are two independent values:

- outbound SDK requests are configured with `STRIPE_API_VERSION=2026-06-24.dahlia`;
- real Event payloads observed on the current test account reported
  `api_version=2025-12-15.clover`.

`STRIPE_WEBHOOK_API_VERSION` must match the endpoint's actual Event snapshot. Request
pinning does not rewrite Events. Unit fixtures exercising Dahlia-shaped fields are not
evidence that real Dahlia webhook Events were received.

Record both values separately in release evidence:

```text
request_api_version:
webhook_event_api_version:
webhook_endpoint_id (private release record only):
stripe-python version:
PostgreSQL version:
automated real tests:
manual scenarios:
skipped scenarios and reason:
```

## Required release commands

```bash
uv sync --frozen
uv run ruff check .
uv run mypy src
uv run pytest -m "not real_stripe"

cd web
npm ci
npm audit --omit=dev
npm run lint
npm run typecheck
npm test
npm run build

git diff --check
```

The real Stripe suite and manual matrix are explicit release gates when their corresponding
payload, pricing, Portal or plan-change behavior changes. See
[the release checklist](../.github/RELEASE_CHECKLIST.md).
