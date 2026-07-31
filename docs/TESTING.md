# Testing strategy and evidence boundary

The project separates deterministic local/PostgreSQL tests, opt-in automated Stripe
test-mode tests, manual Stripe observations, and production verification. Passing one
layer must not be described as passing another.

Latest verified 2026-07-31 result: 167 local/backend tests, 6 real Stripe
test-mode tests, 47 frontend tests, and 1 real-browser Stripe lifecycle passed;
the frontend production build and production-dependency audit also passed.
`npm audit --omit=dev` reported zero; the full audit still reports nine high-severity
development-only ESLint/minimatch/brace-expansion advisories whose available npm fix is
the breaking ESLint 10 upgrade.

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

## Real-browser Checkout gate

`web/e2e/stripe-checkout.spec.ts` is an opt-in Playwright lifecycle, not part of the
network-free CI job. It requires an isolated Free account and real Stripe test-mode
Checkout. One serial Session first submits Stripe's decline card, proves the account is
still Free, then submits Stripe's 3DS-required card, completes the challenge, and waits
for `GET /api/account` to expose Starter Monthly with 300 enforceable credits.

The browser refuses card entry unless the actual hosted URL contains a `cs_test_`
Session. A remote base URL requires a second explicit acknowledgement. The full-stack
runner also creates and verifies a temporary test Webhook Endpoint and inspects
PostgreSQL for handled signed Events at the configured snapshot version.

This gate proves the browser/Checkout/SCA/webhook/UI path only when actually run. Its
existence or `--list` output is not execution evidence. See
[the real-browser E2E runbook](BROWSER_E2E.md) for exact prerequisites, commands,
artifact handling, and evidence boundaries.

Endpoint metadata, signed transport, database projection and live-production evidence
requirements are separated in [the webhook verification runbook](WEBHOOK_VERIFICATION.md).

The verified 2026-07-31 browser run completed in about one minute, including a 10-second
decline stability barrier. Its two required handled Events projected
Starter/Monthly/300. The signed endpoint payloads used
`2026-06-24.dahlia`; retrieving the same Event IDs through Stripe's Event API exposed
the independent `2025-12-15.clover` view. Cleanup left zero run-owned Webhook Endpoints.

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
- real `pending_if_incomplete` behavior with both an authentication-required Payment
  Method and an attachable/customer-charge-failure Payment Method: `pending_update`
  exists, the old Starter SKU remains active, the latest Invoice stays open, the local
  Starter/Monthly/300 entitlement remains unchanged, client secrets are not stored,
  and each real `invoice.payment_failed` Event is projected to the durable incident path
  without changing grant epoch, expiry, revocation or ledger state;
- an isolated annual Test Clock lifecycle: initial paid annual slot 1, a +32-day slot 2,
  a single current-slot grant after a jump to approximately +190 days without backfill,
  and a real renewal `invoice.paid` after `period_end + 1 hour` resetting the new funding
  invoice to slot 1 and extending an active, non-revoked, enforceable entitlement period;
- cleanup of only run-marked objects, idempotent create identities, a metadata recovery
  sweep, and a test failure if any cleanup or inventory operation fails.

The plan-change and Test Clock tests use direct Stripe test-mode requests plus Event
polling, followed by the real PostgreSQL processor. They do **not** prove signed webhook
transport or delivery ordering. The hard-decline fixture `pm_card_chargeDeclined` fails
at PaymentMethod attachment and therefore cannot model a stored card that fails later;
the repeatable charge-failure case uses `pm_card_chargeCustomerFail`.

The real suite does not prove arbitrary Dashboard policy, delivery latency, production
tax/accounting settings, live mode, or unsupported invoice shapes.

Run only the annual time-travel lifecycle with a fail-fast key guard:

```bash
scripts/run_test_clock_e2e.sh
```

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
| declined immediate change | old SKU and active Subscription remained; latest Invoice was open; hosted recovery URL and confirmation secret existed | originally manual; now repeated automatically with authentication-required and customer-charge-failure fixtures |

Amounts are observations for that test account/time, not universal expected values. These
manual checks contain no committed customer, Event, Invoice or secret IDs and should be
rerun before a release that changes plan transitions or Stripe API version.

## Stripe version evidence

There are three version observations that must remain independent:

- outbound SDK requests are configured with `STRIPE_API_VERSION=2026-06-24.dahlia`;
- real Events retrieved through the test account's Event API reported
  `api_version=2025-12-15.clover`;
- real signed payloads delivered to an isolated endpoint explicitly pinned to Dahlia
  reported `api_version=2026-06-24.dahlia`.

`STRIPE_WEBHOOK_API_VERSION` must match the endpoint's actual Event snapshot. Request
pinning does not rewrite Events, and an Event API retrieval view must not be used as a
substitute for the endpoint's signed delivery serialization. The browser gate now
provides real test-mode Dahlia delivery evidence; it is not live-production evidence.

Record all views separately in release evidence:

```text
request_api_version:
endpoint_signed_payload_api_version:
event_api_retrieval_view_version:
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

# Explicit networked release gate; requires isolated Stripe test infrastructure.
cd ..
scripts/run_browser_e2e.sh

git diff --check
```

The real Stripe suite and manual matrix are explicit release gates when their corresponding
payload, pricing, Portal or plan-change behavior changes. See
[the release checklist](../.github/RELEASE_CHECKLIST.md).
