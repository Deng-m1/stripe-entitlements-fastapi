# Testing strategy and evidence boundary

The project separates deterministic local/PostgreSQL tests, opt-in automated Stripe
test-mode tests, real-browser signed-delivery tests, manual observations, and live
production verification. Passing one layer must not be described as passing another.

Current `0.2.1` release-candidate evidence recorded on 2026-08-18:

| Layer | Current result | Boundary |
| --- | --- | --- |
| Local/backend | 701 passed from 710 collected; 9 `real_stripe` cases deselected | Real PostgreSQL, mocked Stripe responses |
| Frontend | 102 passed; lint, typecheck, production build, production npm audit, and complete npm audit passed | No Stripe network |
| Real Stripe suite | 9/9 passed with strict cleanup and zero run-owned active inventory | Direct test-mode API/Event polling; not signed delivery |
| Browser policy gates, CLI transport | 2/2 passed: `full_period_reset` and `prorated_delta`; each reached Pro/1,000 with 7 related, 0 unrelated, and exactly 3 essential Events | Real Checkout/3DS/SCA and signed Stripe CLI forwarding; not endpoint metadata |
| Wheel/container | Independent Wheel install plus four-migration PostgreSQL run passed; UID/GID 10001 read-only Docker health passed | Built artifacts, not Stripe network |
| Temporary endpoint gates | Latest dual-policy pass remains 2026-08-02 | Version-pinned endpoint metadata and signed Dahlia delivery |
| Live production payload | **not run** | Test mode never substitutes for live mode |

The earlier 2026-08-01 pre-hardening baseline—239 local/backend, 7 real Stripe,
60 frontend, and 2 browser policy runs—is retained only as historical regression
evidence. It must not be cited as proof of the current tree. The current Python,
production npm, and complete npm audits all report zero known vulnerabilities; future
advisories still require a fresh release run.

## Default backend suite

`pytest -m "not real_stripe"` starts a disposable PostgreSQL 17 container on a
workspace-derived loopback port, applies all real SQL migrations, and removes the
container after the session. Its data directory is a 512 MiB container tmpfs, so test
data is never persisted and the gate does not consume Docker writable-layer storage.
Set `TEST_POSTGRES_IMAGE` to an equivalent trusted PostgreSQL 17 image when the
canonical tag is unavailable locally. Each test truncates all correctness tables.

Coverage includes:

- plan catalog validation and both complete 6 × 6 transition matrices;
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
- atomic `previewed → applying`, `remote_started_at`, same-key recovery below 23
  hours, and an automatic-replay stop at the 23-hour boundary;
- Schedule create-only crash recovery, configured-policy verification, and rejection of
  unrelated or drifted Schedules;
- paid-Invoice authorization of plan changes and rejection without durable intent;
- exact settlement-Invoice binding for paid/payment-failed Events, including delayed
  old failures that create an incident without changing the new intent or source access;
- exact-ID incident resolution on coordinator binding and later paid settlement, without
  clearing delayed failures for another Invoice or account;
- paid-webhook-before-coordinator-finish races, including atomic same-ID binding,
  blocked-paid failure, and confirm conflict instead of false synchronous success;
- full-period reset and prorated-delta preview/apply parameter contracts;
- exact delta preview-to-paid source/target/net/currency/period binding and symmetric
  full-period preview/paid rejection of balance, credit note, tax, discount, pagination,
  quantity, and amount drift;
- complete Invoice line pagination plus legacy and Dahlia Price references;
- delta paid/update/reconciliation order permutations and stale funding snapshots;
- delta source/target ambiguity, missing/unknown lines, zero target, inconsistent
  fractions, balance, tax, discount, and period drift fail-closed cases;
- delta delivery/business duplicates, real PostgreSQL concurrency, rollback/retry,
  chained allocation, old-epoch, refund-before-paid, and dispute-before-paid cases;
- cross-account Invoice/grant/allocation clawback rejection, insufficient-balance
  clawback debt, and same-epoch debt collection from usage refunds or delta grants;
- distinct-Event terminal-closure idempotency for refund-before-paid blocks, delta leaf
  reversion, and annual funding closure through `closure_applied`;
- product credit charges/refunds across entitlement epochs and revocation;
- bounded reconciliation rotation across `applying`, `applied`, `requires_action`, and
  expired-entitlement candidates;
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

The 102-test suite covers annual total/equivalent/savings display, full-period and
prorated-delta immediate copy, explicit period-end copy, all annual-origin policy cases
(including `SY → PY/UY`), reusable Checkout/preview/Portal idempotency intents, pending
state, hosted-invoice recovery, strict Stripe.js confirmation methods/statuses, and
polling until webhook-projected target state. It also covers bounded HTTP timeouts,
redirect and access-token validation, no-store fetch options, sanitized provider errors,
build-time production demo rejection, security headers, fail-closed public-site URL and
indexing configuration, server-rendered reference plans, visible landing/FAQ JSON-LD,
and metadata-route defaults.
The browser-process environment test proves that Chromium receives only a narrow
runtime allowlist, not the Node helper's Stripe test key or database DSN.
The backend additionally verifies that the public JSON catalog cannot drift from
`plans.toml` prices, entitlements, descriptions, or order.

The frontend never tests or grants backend entitlement by itself.

## Real-browser Checkout gate

`web/e2e/stripe-checkout.spec.ts` is an opt-in Playwright lifecycle, not part of the
network-free CI job. It requires an isolated Free account and real Stripe test-mode
Checkout. One serial Session first submits Stripe's decline card, proves the account is
still Free, then submits Stripe's 3DS-required card, completes the challenge, and waits
for `GET /api/account` to expose Starter Monthly with 300 enforceable credits. It then
uses the real Next.js preview/confirm UI for the configured transition policy and waits
for Pro Monthly with 1,000 credits.

The browser refuses card entry unless the actual hosted URL contains a `cs_test_`
Session. A remote base URL requires a second explicit acknowledgement. The full-stack
runner defaults to creating and verifying a temporary test Webhook Endpoint; an explicit
Stripe CLI mode is available for local signed forwarding when a Quick Tunnel is
unavailable. Both inspect PostgreSQL for handled signed Events at the configured snapshot
version. The final verifier binds exactly one Checkout Event, one initial `invoice.paid`, and one
settlement `invoice.paid` to this run's account, Session, two funding Invoices, grants,
and allocation policy; it also requires no unresolved incident for those identities.
Every additional account-matched Event is checked against Stripe's identity, type, mode,
and version, but an incidental total Event count is not part of the invariant.

This gate proves the browser/Checkout/SCA/webhook/UI path only when actually run. Its
existence or `--list` output is not execution evidence. See
[the real-browser E2E runbook](BROWSER_E2E.md) for exact prerequisites, commands,
artifact handling, and evidence boundaries.

Endpoint metadata, signed transport, database projection and live-production evidence
requirements are separated in [the webhook verification runbook](WEBHOOK_VERIFICATION.md).

Current `0.2.1` CLI-transport evidence: both policies passed on 2026-08-18. Each
projected Starter/Monthly/300 and Pro/Monthly/1,000, observed seven account-related and
zero unrelated Events, bound exactly three essential signed Events, used signed Clover
payloads for that test account, had no unresolved identity-related incident, and
completed strict cleanup. This does not prove Webhook Endpoint metadata or endpoint-
specific version pinning.

The latest endpoint-mode evidence remains the 2026-08-02 full-period and prorated-delta
runs, which completed in about 1.6 and 1.7 minutes. Each verified a Dahlia endpoint
payload versus the independent Clover Event API view and met the same projection,
identity, incident, and cleanup checks. Each happened to observe seven account-related
Events; seven is incidental and is not a fixed assertion.

Historical note: the pre-hardening 2026-08-01 policy runs each completed in about 1.2
minutes and happened to store five account-related signed Events. Those older runs are
retained only as regression history.

## Automated real Stripe suite

Tests marked `real_stripe` make network calls only when `STRIPE_SECRET_KEY` starts with
`sk_test_`. Live keys fail before a network call. Objects are uniquely marked and cleanup
targets only objects created by that run.

The current nine-case automated suite passed on the `0.2.1` release candidate on
2026-08-18 and asserts:

- creation of isolated real test-mode Products, monthly/yearly Prices, Customers and
  Subscriptions;
- retrieval/preparation of the real `invoice.paid` Event;
- projection of that paid $19 invoice to 300 credits in PostgreSQL;
- a real $9.50 partial refund and `charge.refunded` Event converging to 150 credits;
- outbound Dahlia preview/update calls for a real mid-cycle Starter Monthly →
  Pro Monthly full-price/no-proration change, followed by a separately versioned
  `invoice.paid` Event converging to Pro/1,000 credits in PostgreSQL;
- a real Starter Monthly → Pro Monthly prorated-delta lifecycle: initial paid Invoice,
  fixed-date preview/apply, two-line paid upgrade Invoice, 700-credit allocation linked
  to the source Invoice, and a real full refund returning to Starter/300 without
  revoking the still-funded source entitlement;
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
- cleanup of only run-marked objects, idempotent create identities, and complete
  auto-pagination for every Stripe list/inventory operation;
- a post-cleanup zero-inventory assertion covering non-canceled Subscriptions, Customers,
  active Prices/Products, Test Clocks, and unfinished Subscription Schedules;
- a test failure if cleanup, inventory, or zero-inventory verification fails.

All nine assertions passed against Stripe test mode on 2026-08-18 after the current
hardening and guard simplification. The earlier seven-case run is historical evidence
only; future releases must rerun the current suite rather than inheriting either result.

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

The wrapper creates a private mode-`0700` recovery directory containing a mode-`0600`,
secret-free JSON manifest. The test atomically records its run ID and each created Stripe
object ID as creation proceeds. A fully successful test removes the manifest and the
wrapper removes the directory. A failure, skip, cleanup error, or shell interruption
retains the directory and prints its exact path for bounded manual recovery. The manifest
never contains an API key, webhook secret, database URL, client secret, or recovery URL.

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
| declined immediate change | old SKU and active Subscription remained; latest Invoice was open; hosted recovery URL and confirmation secret existed | originally manual; the current 4-case automated failed-payment matrix passed again on 2026-08-18 |

Amounts are observations for that test account/time, not universal expected values. These
manual checks contain no committed customer, Event, Invoice or secret IDs and should be
rerun before a release that changes plan transitions or Stripe API version.

## Stripe version evidence

There are three version records that must remain independent:

- outbound SDK requests are configured with `STRIPE_API_VERSION=2026-06-24.dahlia`;
- the 2026-08-18 Stripe CLI signed-forwarding runs observed
  `api_version=2025-12-15.clover` for their signed payload/Event API view;
- the separate 2026-08-02 temporary endpoints explicitly pinned to Dahlia delivered
  signed payloads with `api_version=2026-06-24.dahlia`, while Event API retrieval still
  reported Clover.

`STRIPE_WEBHOOK_API_VERSION` must match the actual signed transport's Event snapshot.
Request pinning does not rewrite Events, and an Event API retrieval view or CLI forwarding
must not be used as a substitute for endpoint metadata. Neither transport result is live-
production evidence.

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
uv run ruff format --check .
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
E2E_TRANSITION_POLICY=full_period_reset scripts/run_browser_e2e.sh
E2E_TRANSITION_POLICY=prorated_delta scripts/run_browser_e2e.sh

git diff --check
```

The real Stripe suite and manual matrix are explicit release gates when their corresponding
payload, pricing, Portal or plan-change behavior changes. See
[the release checklist](../.github/RELEASE_CHECKLIST.md).
