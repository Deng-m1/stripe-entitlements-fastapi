# Real-browser Stripe Checkout and plan-upgrade E2E

The opt-in Playwright gate drives the real Next.js UI and a real Stripe-hosted
**test-mode** Checkout. It is intentionally stateful and serial:

1. confirm the browser-visible account starts on `free` with zero credits;
2. create Starter Monthly Checkout through the application's UI;
3. stop before card entry unless the Stripe URL contains a real `cs_test_` Session;
4. submit Stripe's `4000000000000002` decline card and confirm the account remains
   `free`, has zero credits, and is not enforceable;
5. hold a server-side stability barrier proving the account stays Free/0 with no credit
   or invoice effect while the owned Checkout Session remains `open/unpaid`;
6. reuse that same Checkout Session with Stripe's `4000002500003155` card;
7. truthfully acknowledge Stripe Sandbox's current AI-agent disclosure when shown;
8. complete Stripe's test 3DS challenge and require its ACS completion response;
9. wait for the frontend account request to report
   `starter/month`, `active`, 300 credits, and enforceable entitlements;
10. confirm the success and account screens render that webhook-projected state.
11. attach the allowlisted upgrade Payment Method only after verifying ownership of the
    run's Subscription; the default fixture requires authentication;
12. use the Next.js UI to preview and confirm the configured upgrade template;
13. complete the upgrade's Stripe.js SCA flow when the default authentication-required
    fixture is used, then require a second signed paid-Invoice projection to reach
    `pro/month`, 1,000 credits, and enforceable entitlements;
14. verify the completed intent and either one 700-credit delta allocation or no delta
    allocation, according to policy.

The redirect and either SCA completion are never treated as entitlement proof. The browser
test captures the application's authenticated `GET /api/account` response. The full
runner additionally requires exactly three identity-bound essential Events in
PostgreSQL: this account's `checkout.session.completed`, initial `invoice.paid`, and
settlement `invoice.paid`. It binds them to the run's Session, two funding Invoices,
ledger grants, and policy-specific allocation, checks every additional account-matched
Event against Stripe, and rejects unresolved incidents for those identities.

A successful complete run proves one isolated Stripe test-mode Checkout and selected
upgrade lifecycle. It does not prove live mode, every bank's 3DS UI, Stripe Tax,
coupons, trials, or arbitrary Checkout settings.

Current evidence boundary: neither policy was rerun after the latest identity binding,
upgrade-SCA, and process-secret isolation hardening. Earlier pre-hardening runs on
2026-08-01 each passed in about 1.2 minutes and happened to observe five signed
account-related Events, Pro/Monthly/1,000, the expected allocation difference, Dahlia
endpoint payloads, a separate Clover Event API view, and strict cleanup. That historical
five-Event count is not a current invariant and those runs are not current-tree browser
evidence.

## Recommended isolated runner

Requirements:

- Docker with the `postgres:17-alpine` image available;
- Python 3.12+, `uv`, Node.js 22+, and npm;
- `cloudflared` for a temporary HTTPS webhook URL;
- Chromium for Playwright (`cd web && npx playwright install chromium` once);
- an isolated Stripe test-mode account with this repository's catalog already
  bootstrapped and verified;
- test-mode secret and publishable keys supplied through a secret manager or ignored
  local environment, never committed or pasted into shared shell history.

Bootstrap/verify the six test Prices and dedicated Portal policy before the run:

```bash
uv run python scripts/bootstrap_stripe.py --verify-only
```

Then invoke the orchestrator once per policy from the repository root:

```bash
case "$STRIPE_SECRET_KEY" in sk_test_*) ;; *) exit 2 ;; esac
case "$STRIPE_PUBLISHABLE_KEY" in pk_test_*) ;; *) exit 2 ;; esac
E2E_STRIPE_EVENT_API_VERSION=2026-06-24.dahlia \
E2E_TRANSITION_POLICY=full_period_reset \
  scripts/run_browser_e2e.sh

E2E_STRIPE_EVENT_API_VERSION=2026-06-24.dahlia \
E2E_TRANSITION_POLICY=prorated_delta \
  scripts/run_browser_e2e.sh
```

If Docker Hub is unavailable, point the runner at an equivalent trusted PostgreSQL 17
image without editing the script:

```bash
E2E_POSTGRES_IMAGE=registry.example.test/library/postgres:17-alpine \
  scripts/run_browser_e2e.sh
```

`E2E_STRIPE_EVENT_API_VERSION` is the Event snapshot version requested for the
temporary test Webhook Endpoint. It is not inferred from `STRIPE_API_VERSION`.

The runner:

- starts a disposable, memory-backed PostgreSQL 17 container on a loopback-only random
  port;
- checks PostgreSQL from the host, then applies the real migrations;
- gives the account a unique demo-auth subject;
- starts a Quick Tunnel and creates a temporary **test-mode** Webhook Endpoint;
- verifies its URL, enabled Event set, mode, status, and Event API version;
- keeps its returned signing secret in a mode-`0600` temporary file;
- starts the FastAPI and Next.js development servers on random loopback ports;
- runs `npm --prefix web run test:e2e:stripe`;
- switches only the run-owned Subscription to an allowlisted test Payment Method before
  the upgrade step, after checking test mode, customer identity, account metadata, and
  product line; the default `pm_card_authenticationRequired` exercises upgrade SCA;
- verifies the database projection, exact account/Checkout/initial-Invoice/settlement-
  Invoice lineage, exactly three essential Event identities, and the absence of related
  unresolved incidents;
- matches every account-related stored Event ID, type and mode back to Stripe's
  test-mode Event API without requiring an incidental total Event count;
- verifies signed-payload `api_version` against the temporary endpoint contract and
  records the independently retrieved Event API view version without conflating them;
- expires an unfinished Checkout Session and deletes only the Customer, Subscription,
  and Webhook Endpoint owned by that run;
- writes a mode-`0600`, secret-free cleanup manifest before deletion, falls back to the
  run's unique endpoint description/URL after an unknown create outcome, and fails the
  overall run if any cleanup step fails;
- removes the disposable database and local processes.

The frontend is launched as the directly tracked Next.js process rather than through an
npm parent/child chain, so cleanup waits for the process that owns `.next/dev/lock`.
It starts under an `env -i` allowlist and receives only public frontend settings; it
does not receive the Stripe secret key or database DSN. The Playwright Node helper does
hold the test key and uses the database DSN only for its server-side ownership and
stability checks. Chromium is launched with a separate runtime-only
environment allowlist, so neither value is inherited by the browser process or page.
The publishable key still reaches browser JavaScript through the normal public Next.js
bundle, as intended.

On success the temporary directory is removed. On failure, the runner removes the
signing-secret state file but retains private service logs and a secret-free cleanup
manifest with exact recovery IDs when available. It never prints Stripe API keys,
signing secrets, database credentials, or card input.

## Running Playwright against an existing staging stack

The stack must use a fresh account (or unique verified subject) with no active or
unexpired Checkout claim, a Stripe test key, a test publishable key, signed webhook
delivery, and an empty test database projection. Its backend allowlisted Checkout URLs
must exactly match the frontend origin and paths used by the browser. The Playwright
Node harness also needs a DSN used only for verification against that exact test
database and the matching external subject so it can enforce the decline phase barrier.
A remote origin additionally requires a private Playwright storage-state file for that
same isolated authenticated subject. Create it through the host application's normal
test login and set its mode to `0600`; do not commit or reuse it across accounts.

```bash
cd web
STRIPE_SECRET_KEY="$TEST_STRIPE_SECRET_KEY" \
E2E_RUN_REAL_STRIPE=1 \
E2E_STRIPE_MODE=test \
E2E_TRANSITION_POLICY=prorated_delta \
E2E_BASE_URL=http://127.0.0.1:3000 \
E2E_BACKEND_URL=http://127.0.0.1:8000 \
E2E_DATABASE_URL="$TEST_DATABASE_READ_ONLY_URL" \
E2E_EXTERNAL_REF=browser-e2e-subject \
npm run test:e2e:stripe
```

For a non-loopback HTTPS staging origin, a second acknowledgement is mandatory:

```bash
STRIPE_SECRET_KEY="$TEST_STRIPE_SECRET_KEY" \
E2E_RUN_REAL_STRIPE=1 \
E2E_STRIPE_MODE=test \
E2E_TRANSITION_POLICY=prorated_delta \
E2E_ALLOW_REMOTE_BASE_URL=1 \
E2E_BASE_URL=https://billing-staging.example.test \
E2E_BACKEND_URL=https://billing-api-staging.example.test \
E2E_DATABASE_URL="$STAGING_DATABASE_READ_ONLY_URL" \
E2E_EXTERNAL_REF=browser-e2e-subject \
E2E_STORAGE_STATE="$STAGING_AUTH_STORAGE_STATE" \
npm run test:e2e:stripe
```

Load `TEST_STRIPE_SECRET_KEY` from the staging secret manager; it must start with
`sk_test_`. `E2E_EXTERNAL_REF` must identify the same server-side account authenticated
by `E2E_STORAGE_STATE`; the decline and upgrade helpers query that exact subject and
verify its Customer/Subscription ownership before mutation. The standalone existing-
stack command intentionally does not own the deployment, database, webhook endpoint,
or authentication subject. It therefore cannot run the full wrapper's final account/
Invoice/three-essential-Event verifier or automatic teardown. Use a one-run subject and
isolated test database, then run the staging verification/cleanup procedure for the
exact Subscription, Customer, endpoint evidence, and unresolved incidents. For a
recovery manifest, final database/Event verification, and strict teardown, use
`scripts/run_browser_e2e.sh` instead.

Optional variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `E2E_WEBHOOK_TIMEOUT_MS` | `180000` | Account-projection deadline; 10–600 seconds |
| `E2E_CUSTOMER_EMAIL` | `browser-checkout@example.test` | Fills an editable Checkout email field |
| `E2E_HEADLESS` | headless | Set to `0` for local visual diagnosis |
| `E2E_POSTGRES_IMAGE` | `postgres:17-alpine` | Trusted PostgreSQL 17 image override for the full runner |
| `E2E_DECLINE_STABILITY_SECONDS` | `10` | DB/Stripe decline barrier; 10–60 seconds |
| `E2E_TRANSITION_POLICY` | `full_period_reset` in the full runner | Upgrade template; run both values for release evidence |
| `E2E_UPGRADE_PAYMENT_METHOD` | `pm_card_authenticationRequired` | Allowlisted upgrade fixture; default exercises Stripe.js SCA |
| `E2E_STORAGE_STATE` | unset locally; required remotely | Private mode-`0600` Playwright auth state for the exact isolated subject |

The Playwright Node harness requires a test secret and database DSN for server-side
Checkout ownership, decline stability, and upgrade-payment preparation checks; it
rejects non-`sk_test_` keys while loading configuration. The secret and DSN remain in
the Node helper, are not supplied to the Next.js process by the full runner, and are
removed from Chromium's launch environment. They never enter the frontend bundle or
browser page. Missing opt-in values fail before a browser or network request.
Remote HTTP, URL credentials, URL query/fragment, and non-origin paths are rejected.
Before any Checkout POST, the test verifies the attested backend, binds the frontend's
actual catalog/write origin to it, and injects an in-request `test` mode precondition;
the backend rejects that precondition before account or Stripe state changes if its
actual gateway is live. It then rechecks the hosted URL and refuses card entry unless
its Session ID begins with `cs_test_`.

## Existing-stack environment contract

For the repository's local demo adapter, the following values must agree across the
backend and frontend. Put secrets in ignored environment files; the names below show the
contract, not values to commit.

```text
Backend:
  APP_ENV=development
  STRIPE_SECRET_KEY=sk_test_...
  STRIPE_WEBHOOK_SECRET=whsec_...
  STRIPE_WEBHOOK_API_VERSION=<actual endpoint Event snapshot version>
  CHECKOUT_SUCCESS_URL=<E2E_BASE_URL>/billing/success
  CHECKOUT_CANCEL_URL=<E2E_BASE_URL>/pricing
  PORTAL_RETURN_URL=<E2E_BASE_URL>/account
  FRONTEND_ORIGINS=<E2E_BASE_URL>
  DEMO_BEARER_TOKEN=<random local value>
  DEMO_BEARER_SUBJECT=<unique value for this run>
  BILLING_TRANSITION_POLICY=<full_period_reset|prorated_delta>

Frontend process environment:
  NEXT_PUBLIC_BILLING_API_MODE=http
  NEXT_PUBLIC_BILLING_API_BASE_URL=<backend origin>
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_...
  NEXT_PUBLIC_DEMO_BEARER_TOKEN=<same random local value>

Playwright process:
  E2E_TRANSITION_POLICY=<same backend value>
  E2E_EXTERNAL_REF=<the authenticated one-run subject>
  E2E_STORAGE_STATE=<private mode-0600 file; required for a remote origin>
```

The demo token is browser-visible by design and is allowed only in development with an
`sk_test_` backend. Do not deploy this adapter as production authentication.

## Failure diagnosis

- **Initial account is not Free:** use a new disposable database and unique subject.
  Browser retries are disabled because this is a stateful billing lifecycle.
- **Runner stops before the tunnel:** inspect the retained `migrate.log`; the runner
  separately checks container readiness and host-side database connectivity first.
- **Checkout returns 400/409:** verify exact allowlisted origins/paths, test catalog
  lookup keys, and whether an older unexpired Checkout owns the account claim.
- **No `/api/account` response:** verify the frontend HTTP mode, demo token, and CORS
  origin; mock mode is deliberately rejected by the initial-state assertion.
- **No decline message:** inspect Stripe's current Checkout DOM and the retained trace;
  Stripe may have changed hosted copy or field structure.
- **No 3DS challenge:** confirm the Session is `cs_test_` and the card is Stripe's
  documented `4000002500003155` test card.
- **3DS remains open:** confirm the Sandbox AI-agent disclosure was checked, then
  inspect whether the test ACS completion POST returned 2xx and its iframe detached.
- **Webhook timeout:** verify endpoint delivery status, the exact signing secret, Event
  snapshot version, backend 5xx logs, and unresolved `billing_incidents`. A successful
  browser redirect does not waive this failure.

On failure, Playwright retains a trace and screenshot under ignored `web/test-results/`.
Open a trace locally with `npx playwright show-trace <trace.zip>`. Treat artifacts as
private test evidence: they can contain hosted Session URLs, test customer identifiers,
test email, and browser/network snapshots. Do not attach them unredacted to public
issues. Passing runs retain no trace or video.

## Relationship to Test Clocks

A successful browser gate proves interactive Checkout, decline, SCA, signed delivery,
and UI projection in wall-clock time. Stripe Test Clocks are a separate lifecycle
harness for renewal and future boundaries. A clock belongs to a Customer from creation
time, so a normal Checkout-created Customer cannot be retroactively attached to a
clock. Do not describe this browser test as a renewal or time-travel test; run the
documented Test Clock scenarios independently and join the evidence only at the release
checklist.
