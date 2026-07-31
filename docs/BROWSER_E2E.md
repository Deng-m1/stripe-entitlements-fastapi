# Real-browser Stripe Checkout E2E

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

The redirect and 3DS completion are never treated as entitlement proof. The browser
test captures the application's authenticated `GET /api/account` response. The full
runner additionally checks PostgreSQL for handled `checkout.session.completed` and
`invoice.paid` Events with the endpoint's pinned Event snapshot version.

This proves one isolated Stripe test-mode Checkout lifecycle. It does not prove live
mode, every bank's 3DS UI, Stripe Tax, coupons, trials, or arbitrary Checkout settings.

Latest verified 2026-07-31 evidence: Playwright passed the lifecycle in about one minute,
including the 10-second decline stability barrier; PostgreSQL contained the two required
handled Events and Starter/Monthly/300; signed payloads matched the temporary Dahlia
endpoint contract while Stripe Event API retrieval reported the independent Clover view;
strict cleanup passed and the post-run endpoint/customer/Test-Clock inventory was empty.

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

Then invoke the orchestrator from the repository root:

```bash
case "$STRIPE_SECRET_KEY" in sk_test_*) ;; *) exit 2 ;; esac
case "$STRIPE_PUBLISHABLE_KEY" in pk_test_*) ;; *) exit 2 ;; esac
E2E_STRIPE_EVENT_API_VERSION=2026-06-24.dahlia \
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

- starts a disposable PostgreSQL 17 container on a loopback-only random port;
- checks PostgreSQL from the host, then applies the real migrations;
- gives the account a unique demo-auth subject;
- starts a Quick Tunnel and creates a temporary **test-mode** Webhook Endpoint;
- verifies its URL, enabled Event set, mode, status, and Event API version;
- keeps its returned signing secret in a mode-`0600` temporary file;
- starts the FastAPI and Next.js development servers on random loopback ports;
- runs `npm --prefix web run test:e2e:stripe`;
- verifies the database projection and matches every stored Event ID, type and mode
  back to Stripe's test-mode Event API;
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

On success the temporary directory is removed. On failure, the runner removes the
signing-secret state file but retains private service logs and a secret-free cleanup
manifest with exact recovery IDs when available. It never prints Stripe API keys,
signing secrets, database credentials, or card input.

## Running Playwright against an existing staging stack

The stack must use a fresh account (or unique verified subject) with no active or
unexpired Checkout claim, a Stripe test key, a test publishable key, signed webhook
delivery, and an empty test database projection. Its backend allowlisted Checkout URLs
must exactly match the frontend origin and paths used by the browser. The local
Playwright harness also needs a read-only DSN for that exact test database and the
matching external subject so it can enforce the decline phase barrier.

```bash
cd web
STRIPE_SECRET_KEY="$TEST_STRIPE_SECRET_KEY" \
E2E_RUN_REAL_STRIPE=1 \
E2E_STRIPE_MODE=test \
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
E2E_ALLOW_REMOTE_BASE_URL=1 \
E2E_BASE_URL=https://billing-staging.example.test \
E2E_BACKEND_URL=https://billing-api-staging.example.test \
E2E_DATABASE_URL="$STAGING_DATABASE_READ_ONLY_URL" \
E2E_EXTERNAL_REF=browser-e2e-subject \
npm run test:e2e:stripe
```

Load `TEST_STRIPE_SECRET_KEY` from the staging secret manager; it must start with
`sk_test_`. The standalone existing-stack command intentionally does not own the
deployment, database, webhook endpoint, or authentication subject, so it cannot safely
perform automatic teardown. Use a one-run subject and isolated test database, then
cancel/delete the exact run-owned test Subscription and Customer through the staging
cleanup procedure and verify the account is not reused. For automatic ownership checks,
a recovery manifest, and strict teardown, use `scripts/run_browser_e2e.sh` instead.

Optional variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `E2E_WEBHOOK_TIMEOUT_MS` | `180000` | Account-projection deadline; 10–600 seconds |
| `E2E_CUSTOMER_EMAIL` | `browser-checkout@example.test` | Fills an editable Checkout email field |
| `E2E_HEADLESS` | headless | Set to `0` for local visual diagnosis |
| `E2E_POSTGRES_IMAGE` | `postgres:17-alpine` | Trusted PostgreSQL 17 image override for the full runner |
| `E2E_DECLINE_STABILITY_SECONDS` | `10` | DB/Stripe decline barrier; 10–60 seconds |

The Playwright Node harness requires a test secret only for a read-only retrieval of the
owned Checkout Session during the decline barrier; it rejects non-`sk_test_` keys while
loading configuration. The secret and database DSN are never passed to the browser page
or frontend bundle. Missing opt-in values fail before a browser or network request.
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

Frontend process environment:
  NEXT_PUBLIC_BILLING_API_MODE=http
  NEXT_PUBLIC_BILLING_API_BASE_URL=<backend origin>
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_...
  NEXT_PUBLIC_DEMO_BEARER_TOKEN=<same random local value>
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

This browser gate proves interactive Checkout, decline, SCA, signed delivery, and UI
projection in wall-clock time. Stripe Test Clocks are a separate lifecycle harness for
renewal and future boundaries. A clock belongs to a Customer from creation time, so a
normal Checkout-created Customer cannot be retroactively attached to a clock. Do not
describe this browser test as a renewal or time-travel test; run the documented Test
Clock scenarios independently and join the evidence only at the release checklist.
