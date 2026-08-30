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

The four exact-`f757fcc` browser gates used isolated Stripe test-mode endpoints pinned to
Dahlia and received signed Dahlia payloads while the independently retrieved Event API
view remained Clover. Neither value changes the outbound request version. Stripe CLI
forwarding can prove signed transport but not endpoint metadata. You may inspect the
Event API view privately, but do **not** use it alone to configure an endpoint-backed
webhook processor:

```bash
stripe events list --limit 5
stripe events retrieve evt_REPLACE_ME
```

Retrieve the exact Webhook Endpoint and inspect the application-stored, signature-
verified payload from that delivery instead:

```bash
stripe webhook_endpoints retrieve we_REPLACE_ME
```

Set `STRIPE_WEBHOOK_API_VERSION` only from the endpoint contract plus its actually
delivered signed payload. Do not copy full Event or endpoint output into logs or issues.
The processor stores a mismatch as `webhook_contract_mismatch` and does not apply it.

## Local forwarding

```bash
stripe login
stripe listen --events \\
checkout.session.completed,checkout.session.expired,invoice.paid,invoice.payment_failed,customer.subscription.updated,customer.subscription.deleted,charge.refunded,charge.dispute.created,payment_intent.succeeded \\
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

For a real browser decline → 3DS → signed webhook → account-projection lifecycle, use
[the isolated Playwright runbook](BROWSER_E2E.md). Unlike `stripe trigger`, that test
creates a real Checkout Session bound to the repository account and verifies its actual
business projection. It still runs only in test mode.

Use [the webhook verification runbook](WEBHOOK_VERIFICATION.md) to keep endpoint,
signed-delivery and business-projection evidence separate, including the additional
requirements for a real live-production payload check.

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
# Python / FastAPI operator
uv run python scripts/bootstrap_stripe.py
uv run python scripts/bootstrap_stripe.py --verify-only

# Native TypeScript / Node operator (does not invoke Python or PostgreSQL)
cd typescript
npm ci
npm run build
npx stripe-entitlements bootstrap
npx stripe-entitlements bootstrap --verify-only
```

The build is required before the first CLI command in a source checkout because `dist/`
is generated. An installed release `.tgz` already contains the CLI and needs no rebuild.

Choose the operator that matches the deployed backend; both consume the same canonical
`plans.toml`, lookup-key convention, product-line ownership metadata, price policy, and
Portal safety predicate. The TypeScript command prints secret-free JSON containing the
`portalConfigurationId`; set that value as `STRIPE_PORTAL_CONFIGURATION_ID` before
starting Node or Next.js. It follows every Product, Price, and Portal list page and uses
stable mutation idempotency keys. It refuses to transfer a lookup key from an unrelated
Product and fails closed on duplicate owned Products or Portal configurations.

The TypeScript operator defaults to test mode. A live key is not sufficient authority:
both explicit acknowledgements are required even for the read-only verification path,
and the confirmation must exactly equal the effective `PRODUCT_LINE`:

```bash
cd typescript
npm run build  # required if this source checkout has not been built above
npx stripe-entitlements bootstrap \
  --allow-live \
  --confirm-live-product-line example-entitlements
npx stripe-entitlements bootstrap \
  --verify-only \
  --allow-live \
  --confirm-live-product-line example-entitlements
```

Missing, placeholder, malformed, or insufficiently confirmed live keys fail before the
Stripe SDK client is constructed. There is intentionally no environment-only live
bootstrap opt-in. Optional `--catalog`, `--lookup-prefix`, and `--product-line` flags
override their environment/package defaults for one operator run.

The Portal policy intentionally disables subscription price updates and permits
cancellation only at period end. Plan changes must pass through the authenticated
preview/confirm API so annual funding, invoice preview and durable intent cannot be
bypassed.

Choose one application-controlled transition template before starting the API:

```bash
export BILLING_TRANSITION_POLICY=full_period_reset
# or: prorated_delta
```

This is not a Stripe CLI or Dashboard switch. The value controls the server matrix,
preview/apply parameters, webhook validation, API copy, and durable intent. Keep it
identical across replicas. Existing intents retain their stored policy if the deployment
default later changes.

For local delta inspection, create the change through the authenticated application API,
then inspect the resulting test-mode Invoice privately:

```bash
stripe invoices retrieve in_REPLACE_ME
stripe invoiceitems list --invoice in_REPLACE_ME
```

Expect one negative source proration and one positive target proration. Do not paste the
payload into a public issue. The automated real Stripe suite is stronger than visual
inspection: it prepares all line pages, processes the paid Event into PostgreSQL, checks
the allocation, performs a real full refund, and verifies source-plan convergence.

## Test Clocks: exact boundary

The automated real suite owns a complete isolated annual lifecycle. Prerequisites are a
local disposable PostgreSQL/Docker environment, outbound Stripe access, and a test-mode
secret supplied through the environment. Run the guard before pytest:

```bash
case "$STRIPE_SECRET_KEY" in
  sk_test_*) ;;
  *) echo "refusing non-test key"; exit 1 ;;
esac

scripts/run_test_clock_e2e.sh
```

The wrapper refuses missing, malformed and live keys before pytest can turn an absent
credential into a successful-looking skip. The equivalent lower-level pytest selector
is recorded in `scripts/run_test_clock_e2e.sh`.

The test performs these bounded steps:

1. creates a unique run ID, Test Clock, Product, annual Price and Customer on that clock;
2. creates a paid Starter Yearly Subscription and processes its real `invoice.paid`
   Event into annual grant slot 1;
3. advances to initial frozen time +32 days, waits for `ready`, verifies the remote
   Subscription snapshot, calls `AnnualGrantService` for slot 2, and verifies active,
   non-revoked credits/expiry;
4. advances directly to approximately +190 days and proves the worker grants only the
   current calculated slot rather than backfilling every missed month;
5. advances to the original `period_end + 1 hour`, waits for the paid renewal Invoice,
   processes its real `invoice.paid` Event, and verifies a new funding invoice, slot 1,
   300 credits and a later enforceable entitlement period;
6. deletes/deactivates only run-marked objects, sweeps unknown create outcomes through
   complete auto-pagination, and deletes the Test Clock last;
7. re-lists every page and requires zero non-canceled Subscriptions, Customers, active
   Prices/Products, Test Clocks, and unfinished Schedules for that run ID.

`scripts/run_test_clock_e2e.sh` creates a private mode-`0700` recovery directory and a
mode-`0600`, secret-free manifest. The test atomically adds the run ID and exact object
IDs after each successful create call. Strict cleanup success removes the manifest and
directory; failure, interruption, skip, inventory uncertainty, or residual objects retain
them and print the recovery path. The file contains no Stripe key, signing secret,
database URL, client secret, hosted recovery URL, or card data.

All active API requests are pinned to Dahlia. The 2026-08-02 hardened browser gates
observed independently retrieved Clover Event API views while their pinned endpoints
delivered signed Dahlia payloads. The processor is always configured from the actual
Event contract rather than pretending the request pin rewrites it.

A successful complete run proves Stripe Test Clock advancement, annual worker behavior,
renewal Event shape and PostgreSQL projection. It does not prove signed webhook delivery, arbitrary delivery
order, live-mode behavior, cancellation, tax/discount configurations, or scheduler
availability. Event polling is evidence of Stripe object state, not endpoint transport.

## Manual plan-transition evidence

The current ten-case real suite contains assertions for both a full-price/no-proration
monthly upgrade and a prorated-delta monthly upgrade through paid Event projection. The
delta case performs a real full refund and checks cross-Invoice allocation/reversion;
other cases cover an annual-origin two-phase Schedule and repeatable authentication-
required/customer-charge-failure pending updates. The added case covers a one-time pack
PaymentIntent, exact metadata/lineage and cash/product-refund convergence. All ten passed
on exact commit `f757fcc` on 2026-08-29 with strict run-owned cleanup in both Python and
TypeScript. A later change that touches these runtime paths must rerun the affected gate
rather than inherit that evidence.
Both pre-pack browser policies also passed that day through signed Stripe CLI forwarding
on the production Next.js build.
The earlier seven-case network run is historical evidence only. The remaining 2026-07-31
manual evidence set contains:

- `PY → UM` invoice preview at negative $204, which remains period-end;
- no separate failed-immediate gap. A direct `pm_card_chargeDeclined` Payment Method is
  rejected during attachment and is not equivalent to a stored-card charge failure;
  automation uses the attachable `pm_card_chargeCustomerFail` fixture for that boundary.

These observations are not CLI commands to run blindly and are not part of automated CI.
Use isolated test customers and record both request/Event versions, starting/target
lookup keys, preview totals, final Event types and cleanup. Never commit raw identifiers.

## Production cutover

Test and live mode do not share Products, Prices, Portal configurations, webhook
endpoints, Events or signing secrets.

1. choose the matching operator and bootstrap with an explicitly approved live key:
   Python uses `bootstrap_stripe.py --allow-live`; TypeScript uses
   `stripe-entitlements bootstrap --allow-live --confirm-live-product-line <exact-line>`;
2. run that operator's `--verify-only` form (including both TypeScript live
   acknowledgements) and save its secret-free/redacted output in the private release
   record;
3. create a new live webhook endpoint with only the supported event types;
4. inspect a live endpoint Event snapshot and set `STRIPE_WEBHOOK_API_VERSION` to it;
5. configure the new live signing secret independently;
6. run a low-risk end-to-end Checkout, Portal cancel-at-period-end and recovery test;
7. verify the account changes only after signed webhook projection;
8. monitor unresolved incidents and webhook 5xx before increasing traffic.

Never use `stripe trigger` or the automated object-creation suite with a live key.
