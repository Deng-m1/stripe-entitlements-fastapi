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
8. complete Stripe's test 3DS challenge, require the challenge frame to detach, and
   reject any observed ACS response with an HTTP error status;
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

Current local signed-forwarding evidence: both policies passed on the 0.3 baseline
candidate on 2026-08-28 through explicit Stripe CLI forwarding. Each reached
Pro/Monthly/1,000, observed seven account-related and zero unrelated Events, bound exactly
three essential Events, used a Clover signed payload/Event API view for that test account,
had no unresolved run-related incident, and completed strict cleanup. This proves the
raw-signature, application, browser, and PostgreSQL path, not Webhook Endpoint metadata.

The 2026-08-28 endpoint-mode retry created and verified a temporary Dahlia endpoint but
stopped before account creation or Checkout because the account-less Quick Tunnel
hostname remained DNS `NXDOMAIN`. Recovery verified the endpoint was closed; no current
endpoint-mode pass is claimed from that attempt.

The latest stronger endpoint-mode evidence remains the 2026-08-02 dual-policy run.
`full_period_reset` completed in about 1.6 minutes and `prorated_delta` in about
1.7 minutes. Each used an isolated version-pinned Dahlia endpoint, reached
Pro/Monthly/1,000, bound exactly three essential Events, found zero unrelated Events,
recorded a separate Clover Event API view, and completed strict cleanup. Each run happened
to observe seven account-related Events; that incidental count is not an invariant.
Earlier pre-hardening 2026-08-01 runs happened to observe five and are retained only as
historical regression evidence.

## Recommended isolated runner

Requirements:

- Docker with the `postgres:17-alpine` image available;
- Python 3.12+, `uv`, Node.js 22+, and npm;
- OpenSSL for the runner-owned one-day loopback certificate;
- `cloudflared` for the default temporary-endpoint transport, or Stripe CLI for the
  explicit local signed-forwarding transport;
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

### Webhook transport modes

`E2E_WEBHOOK_TRANSPORT=endpoint` is the default and the stronger release-evidence mode.
It starts a Quick Tunnel, creates a temporary version-pinned test Webhook Endpoint,
preflights the public `/health` path before any Checkout state is created, and verifies
endpoint URL, enabled Event set, mode, status, and Event API version. A failed tunnel
therefore stops before the stateful lifecycle rather than timing out after a payment.

For local recording or diagnosis when a Quick Tunnel is unavailable, opt into Stripe
CLI signed forwarding and provide the actual CLI-delivered Event version explicitly:

```bash
E2E_WEBHOOK_TRANSPORT=stripe_cli \
E2E_STRIPE_EVENT_API_VERSION=2025-12-15.clover \
E2E_TRANSITION_POLICY=prorated_delta \
scripts/run_browser_e2e.sh
```

The value above is an example from one test account; inspect the listener/account
contract rather than copying it blindly. CLI mode still supplies the temporary signing
secret to the backend, forwards only the eight supported raw Events, executes the same
browser and PostgreSQL assertions, matches stored Event identities back to Stripe, and
performs strict run-owned account cleanup. It does **not** create or verify a Webhook
Endpoint and must not be reported as endpoint-metadata or endpoint-version-pin evidence.

The runner:

- starts a disposable, memory-backed PostgreSQL 17 container on a loopback-only random
  port;
- checks PostgreSQL from the host, then applies the real migrations;
- gives the account a unique demo-auth subject;
- in default endpoint mode, starts a Quick Tunnel, creates a temporary **test-mode**
  Webhook Endpoint, preflights public reachability, and verifies URL, enabled Event set,
  mode, status, and Event API version;
- in explicit CLI mode, starts a locally authenticated listener for only the supported
  Event set and redacts its signing secret from the retained private log;
- keeps any endpoint-returned signing secret in a mode-`0600` temporary file;
- starts FastAPI over runner-owned loopback HTTPS, builds Next.js with only the
  public backend URL and test publishable key, and serves that production bundle
  through a minimal Node HTTPS/Next production server on a random loopback port;
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
- treats `E2E_OUTPUT_DIR` as an artifact root, creates and prints a unique child for
  every run, and never recursively deletes the caller-supplied root;
- removes the disposable database and local processes.

The runner builds and launches the directly tracked Next.js production process rather
than using `next dev` or an npm parent/child chain. Both build and HTTPS start run under
separate `env -i` allowlists. The build sees only public frontend settings plus a fixed
non-secret, non-public-name acknowledgement that enables its E2E-only route-auth mode;
neither process receives the Stripe secret key, webhook secret, database DSN, or demo
Bearer token. This mode is accepted only for a production HTTP-mode build whose backend
is an HTTPS loopback origin, whose indexing flag is explicitly `false`, and which has no
browser demo token. It compiles one fixed, deliberately invalid public sentinel into the
page. The Playwright Node helper holds the test key and database DSN for server-side
ownership/stability checks, and holds the one-run demo Bearer token solely to replace
that exact sentinel on the attested backend origin's `/api/` requests. It fetches without
following redirects and fulfills the 30x back to Chromium, so a redirected request is
new and never inherits the real token. The helper never adds that token to Stripe,
another origin, the frontend document, or a response. Without Playwright interception,
the backend sees only the known-invalid sentinel and returns `401`.
Chromium is launched with a separate runtime-only environment allowlist, so these
values are not inherited by the browser process or bundled page. The publishable key
still reaches browser JavaScript through the normal public Next.js bundle, as intended.
The browser does not globally ignore HTTPS errors: the runner derives a SHA-256 SPKI
pin from its one-day loopback certificate and allows only that certificate for the
frontend and backend origins. Stripe Hosted Checkout retains normal certificate
validation. Playwright's Node-only `route.fetch()` process separately trusts that same
one-run certificate through `NODE_EXTRA_CA_CERTS`; the browser environment allowlist
does not pass this variable into Chromium.

The runner reports `E2E passed` only after the final database verifier and every cleanup
step succeed. On success the private temporary directory is removed and the unique
artifact child remains at the printed path. On failure, the runner removes the
signing-secret state file but retains private service logs and a secret-free cleanup
manifest with exact recovery IDs when available. It never prints Stripe API keys,
signing secrets, database credentials, or card input.

## Running Playwright against an existing staging stack

The stack must serve a production Next.js build carrying the
`X-Frontend-Build-Mode: production` response header and use a fresh account (or unique verified subject) with no active or
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
E2E_FRONTEND_BUILD_MODE=production \
E2E_TRANSITION_POLICY=prorated_delta \
E2E_BASE_URL=https://127.0.0.1:3000 \
E2E_BACKEND_URL=https://127.0.0.1:8000 \
E2E_DATABASE_URL="$TEST_DATABASE_READ_ONLY_URL" \
E2E_EXTERNAL_REF=browser-e2e-subject \
npm run test:e2e:stripe
```

The repository's full runner supplies an exact SHA-256 SPKI pin for its self-signed
loopback certificate. If an independently managed loopback stack also uses a
self-signed certificate, derive its pin and pass it as `E2E_LOOPBACK_TLS_SPKI`; omit
the value when the certificate is normally trusted. The harness accepts one pin only
and never enables Chromium's global `--ignore-certificate-errors` switch.

For a non-loopback HTTPS staging origin, a second acknowledgement is mandatory:

```bash
STRIPE_SECRET_KEY="$TEST_STRIPE_SECRET_KEY" \
E2E_RUN_REAL_STRIPE=1 \
E2E_STRIPE_MODE=test \
E2E_FRONTEND_BUILD_MODE=production \
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
| `E2E_WEBHOOK_TRANSPORT` | `endpoint` | `endpoint` for release evidence or explicit `stripe_cli` signed forwarding for local diagnosis/recording |
| `E2E_RECORD_VIDEO` | `0` | Set to `1` to retain one Playwright video per page |
| `E2E_DEMO_PAUSE_MS` | `0` | Recording-only scene hold, 0–5,000 ms; assertions do not depend on it |
| `E2E_OUTPUT_DIR` | policy-specific ignored root | Artifact root; the runner creates and prints a unique per-run child and never deletes the root |

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

## Recording and public editing

Set `E2E_RECORD_VIDEO=1` only on an isolated test-mode run. Successful raw recordings can
contain a test email, test card numbers, hosted Session context, and transient Stripe UI.
Keep them under ignored `web/test-results/`, do not attach them to public issues, and do
not publish them directly.

The repository's public editor masks the Checkout form, adds test-mode labels, trims
network waits, and joins the initial and upgrade browser pages. Its reviewer decodes
every frame and performs OCR checks at payment/3DS checkpoints:

```bash
scripts/build_promo_video.sh
scripts/review_promo_video.sh
```

See [Demo recording and promotional video](DEMO_VIDEO.md) for the full workflow and
privacy/evidence boundary.

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
  NEXT_PUBLIC_ALLOW_INDEXING=false                 # full runner build only
  E2E_ALLOW_PRODUCTION_ROUTE_AUTH=1                # full runner build/start only

Playwright process:
  E2E_TRANSITION_POLICY=<same backend value>
  E2E_EXTERNAL_REF=<the authenticated one-run subject>
  E2E_FRONTEND_BUILD_MODE=production
  E2E_LOOPBACK_TLS_SPKI=<optional one-certificate SHA-256 SPKI pin>
  E2E_DEMO_BEARER_TOKEN=<same random local value; full runner only>
  E2E_STORAGE_STATE=<private mode-0600 file; required for a remote origin>
```

The demo token remains a development-only backend adapter credential. The full runner
does not compile it into the production frontend: the page carries only the fixed
invalid route-auth sentinel, and Playwright replaces that value only on exact loopback
backend API requests. The acknowledgement is rejected for remote, HTTP, mock, indexable,
demo-token, or custom-sentinel builds. Do not deploy this adapter as production
authentication.

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
  inspect whether the test button listener attached, whether an observed ACS POST
  returned an error, and whether the challenge iframe detached. The harness narrowly
  retries an enabled test `Complete` button because Stripe can render it before its
  challenge listener is ready.
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
