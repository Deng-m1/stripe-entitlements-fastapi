# Real-browser Auth, Checkout, Portal, credit-pack, and product-Job E2E

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
    allocation, according to policy;
15. create Boost 100 through the UI and require the API response, hosted URL, and return
    query to carry the same real `cs_test_` Session;
16. submit that one-time `mode=payment` Checkout on Stripe's real hosted page;
17. while the runner's in-memory webhook barrier holds only this account's genuine
    `payment_intent.succeeded`, prove the return page still reports Pro 1,000,
    purchased balance 0, and no lot for the Session;
18. release the original signed request, then require Pro 1,000 + purchased 100 = 1,100
    and exactly one unexpired Boost 100 lot bound to that Session;
19. create a real `bps_` Portal Session through the account UI, require the Stripe
    creation response to bind the exact Customer, dedicated safe configuration,
    return URL, object type, and test mode, then open `billing.stripe.com`;
20. use the hosted Portal's return control and require navigation back to `/account`
    with Pro/1,100 unchanged;
21. trigger a product Job from the browser-facing host API, require the user's Personal
    JWT to map to the same owner, then have the host call the private facade with a
    separately signed workload JWT and an explicit workload-to-owner authorization;
22. require that successful Job to charge exactly 80 credits, replay the same operation
    key without a second debit, and observe 1,100 → 1,020;
23. run a terminal-failure Job that charges 20, refunds the original operation key, and
    proves the transient 1,000 balance converges back to 1,020; and
24. verify PostgreSQL contains exactly those two usage debits, exact allocation totals,
    a terminal refund only on the failed Job, and subscription/pack provenance that
    sums to the final browser projection.

Every browser POST that can touch Stripe—subscription Checkout, credit-pack Checkout,
Portal creation, plan-change preview, and plan-change confirmation—carries
`X-Stripe-Mode-Requirement: test`. Both runtimes reject the request before Stripe I/O
when the backend cannot satisfy that assertion. This is a per-request safety belt; it
does not replace the shell's `sk_test_` guard or the browser's pre-write `/health`
attestation.

The redirect and either SCA completion are never treated as entitlement proof. The browser
test captures the application's authenticated `GET /api/account` response. The full
runner additionally requires exactly five identity-bound essential Events in
PostgreSQL: the subscription `checkout.session.completed`, initial `invoice.paid`,
settlement `invoice.paid`, pack `checkout.session.completed`, and authoritative pack
`payment_intent.succeeded`. It binds them to the two Sessions, two funding Invoices,
subscription ledger grants, policy-specific allocation, pack order, PaymentIntent,
Charge, and lot; checks every additional account-matched Event against Stripe; and
rejects unresolved incidents for those identities. The pack Checkout Event records
identity only. Its stored reason must explicitly say the payment webhook remains
authoritative; only the handled PaymentIntent Event may correspond to the funded lot.
The final verifier separately checks the two product-operation idempotency keys and
their debit/allocation/refund equations. Portal opening creates no entitlement Event;
its evidence is the gateway-validated Stripe creation response, the owner-bound
in-process E2E observation, the real hosted DOM, and the observed return to `/account`.

A successful complete run proves one isolated subscription Checkout, selected upgrade
lifecycle, one isolated card-funded one-time credit-pack Checkout, one Portal round trip, and the
Personal-identity → owner → signed-workload → credit-operation boundary in Stripe test mode. Cleanup
fully refunds the positively identified pack Charge before deleting the run-owned
Customer, so the run leaves no refundable pack cash inventory. It does not prove live
mode, a third-party IdP's login UI/session revocation, a production workload issuer,
every bank's 3DS UI, Stripe Tax, coupons, trials, or arbitrary Checkout settings. The
runner's local IdP signs real asymmetric JWTs and serves real HTTPS JWKS; it is evidence
for the starter adapter contract, not a claim that a host application's login page was tested.

The exact-`f757fcc` results below cover the final subscription, Boost 100, Portal, and Job
path in all four backend/policy quadrants. Older runs remain regression history only.

## Real Stripe API credit-pack convergence gate

The browser gate proves hosted interaction and signed delivery. A separate opt-in
`real_stripe` test creates a run-scoped one-time Product, Price, Customer, attached test
PaymentMethod, and confirmed PaymentIntent, then uses the real Event snapshots against
the real PostgreSQL processor:

```bash
case "$STRIPE_SECRET_KEY" in sk_test_*) ;; *) exit 2 ;; esac
uv run pytest -m real_stripe \
  tests/real/test_stripe_test_mode.py \
  -k credit_pack_payment_cash_clawback_and_product_refund_converge
```

It verifies exact amount, currency, complete immutable metadata, Customer,
PaymentIntent, and Charge identity before granting Boost 100. It then charges an
80-credit product Job, applies a cumulative 50-credit partial cash refund, refunds the
product Job, requires convergence to 50 spendable credits, applies the remaining cash
refund, and requires zero spendable lot balance, fully refunded cash, and no outstanding
pack debt. Its `finally` path independently re-verifies run ownership, refunds any
remaining amount, deletes the Customer, archives only the run-tagged Price/Product, and
fails if cleanup leaves active/refundable inventory. Immutable Stripe test history is
not deleted and is not described as active inventory.

Do not use `stripe trigger payment_intent.succeeded` as a substitute: generated fixture
metadata is not bound to the database-reserved order. The test retrieves the genuine
Event created by its own confirmed PaymentIntent. Never run it with a shared live key;
the helper rejects every value that does not begin with `sk_test_` before networking.

On exact commit `f757fcc`, Python and TypeScript each passed `full_period_reset` and
`prorated_delta` through four temporary Stripe test-mode endpoints. Every run bound five
essential signed Events, observed 11 account-related and zero unrelated Events, covered
the pack/Portal/Job path, ended at Pro/1,020, passed the database verifier, and completed
strict endpoint/account/Stripe-object/PostgreSQL cleanup. Signed endpoint payloads were
`2026-06-24.dahlia`; the independently retrieved Event API view was
`2025-12-15.clover`. This does not claim a live-production payload.

Earlier CLI-forwarding, `0.2.2`/`0.3`, Quick Tunnel `NXDOMAIN`, working-tree endpoint, and
2026-08-02 version runs remain historical regression evidence only.

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

Bootstrap/verify the six recurring Prices, three one-time pack Prices, and dedicated
Portal policy before the run:

```bash
uv run python scripts/bootstrap_stripe.py --verify-only
```

Then invoke the orchestrator once per backend and policy from the repository root. The
default backend remains `python`; `typescript` builds and starts the native Node host.
All four runs execute the same Playwright spec and final PostgreSQL verifier:

```bash
case "$STRIPE_SECRET_KEY" in sk_test_*) ;; *) exit 2 ;; esac
case "$STRIPE_PUBLISHABLE_KEY" in pk_test_*) ;; *) exit 2 ;; esac
E2E_STRIPE_EVENT_API_VERSION=2026-06-24.dahlia \
E2E_BACKEND_IMPLEMENTATION=python \
E2E_TRANSITION_POLICY=full_period_reset \
  scripts/run_browser_e2e.sh

E2E_STRIPE_EVENT_API_VERSION=2026-06-24.dahlia \
E2E_BACKEND_IMPLEMENTATION=python \
E2E_TRANSITION_POLICY=prorated_delta \
  scripts/run_browser_e2e.sh

E2E_STRIPE_EVENT_API_VERSION=2026-06-24.dahlia \
E2E_BACKEND_IMPLEMENTATION=typescript \
E2E_TRANSITION_POLICY=full_period_reset \
  scripts/run_browser_e2e.sh

E2E_STRIPE_EVENT_API_VERSION=2026-06-24.dahlia \
E2E_BACKEND_IMPLEMENTATION=typescript \
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
It starts a Quick Tunnel with a mode-`0600`, runner-owned empty config so an operator's
`~/.cloudflared/config.yml` or named-Tunnel credentials cannot change the process. It
first requires the public `/health` path to reach the isolated gate, before creating any
Stripe Endpoint. It then creates a temporary version-pinned test Webhook Endpoint,
starts the signed backend, and requires the public `/ready` path to reach that backend
before creating the account or Checkout. The runner verifies endpoint URL, enabled
Event set, mode, status, and Event API version. A failed tunnel therefore stops before
the payment lifecycle rather than timing out after a payment.

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
secret to the backend, forwards only the nine supported raw Events, executes the same
browser and PostgreSQL assertions, matches stored Event identities back to Stripe, and
performs strict run-owned account cleanup. It does **not** create or verify a Webhook
Endpoint and must not be reported as endpoint-metadata or endpoint-version-pin evidence.

The runner:

- starts a disposable, memory-backed PostgreSQL 17 container on a loopback-only random
  port;
- checks PostgreSQL from the host, then applies the real migrations with the selected
  backend CLI;
- creates one ephemeral RSA key in memory, persists only its public JWKS and two
  mode-`0600` short-lived JWTs, and gives the account a canonical
  `v1:user:<UUID>` Personal Auth subject;
- starts the selected FastAPI or native TypeScript host with `APP_ENV=production`,
  `PersonalJwtAuthAdapter`, an HTTPS JWKS
  URL, and a separate workload-audience verifier; no demo adapter is configured;
- verifies the shared Stripe test catalog and resolves the dedicated safe Portal
  configuration before creating any run-owned Stripe object;
- in default endpoint mode, isolates Quick Tunnel from any user config, preflights the
  public gate before creating a temporary **test-mode** Webhook Endpoint, then preflights
  the real backend and verifies URL, enabled Event set, mode, status, and Event API
  version before account creation;
- in explicit CLI mode, starts a locally authenticated listener for only the supported
  Event set and redacts its signing secret from the retained private log;
- starts a loopback webhook proxy whose private filesystem control state contains only
  account/order/Event/pack correlation IDs; the original Stripe signature and payload
  remain in memory, are never logged or written, and only this run's pack PaymentIntent
  is held long enough to prove the browser return has no grant authority;
- keeps any endpoint-returned signing secret in a mode-`0600` temporary file;
- starts FastAPI over runner-owned loopback HTTPS, builds Next.js with only the
  public backend URL and test publishable key, and serves that production bundle
  through a minimal Node HTTPS/Next production server on a random loopback port;
- runs `npm --prefix web run test:e2e:stripe`;
- switches only the run-owned Subscription to an allowlisted test Payment Method before
  the upgrade step, after checking test mode, customer identity, account metadata, and
  product line; the default `pm_card_authenticationRequired` exercises upgrade SCA;
- verifies the database projection, exact account/two-Checkout/initial-Invoice/
  settlement-Invoice/pack-PaymentIntent/Charge/lot lineage, exactly five essential Event
  identities, the successful 80-credit product debit, the 20-credit failed-Job debit and
  exact refund, their funding allocations, and the absence of related unresolved incidents;
- creates an owner-bound `bps_` Portal Session, opens the real hosted Portal, and follows
  its configured return control back to the production Next.js account page;
- sends product Jobs only to the host's browser-facing E2E route; the host derives the
  owner from the verified Personal JWT and calls the no-browser-CORS internal router
  using a separately signed workload JWT and owner authorizer;
- matches every account-related stored Event ID, type and mode back to Stripe's
  test-mode Event API without requiring an incidental total Event count;
- verifies signed-payload `api_version` against the temporary endpoint contract and
  records the independently retrieved Event API view version without conflating them;
- expires unfinished run-owned Checkout Sessions, fully refunds only a pack Charge whose
  Session, PaymentIntent, Charge, Customer, account, order, mode, amount, currency, and
  immutable metadata all agree, then deletes only the run-owned Customer, Subscription,
  and Webhook Endpoint;
- writes a mode-`0600`, secret-free cleanup manifest before deletion, falls back to the
  run's unique endpoint description/URL after an unknown create outcome, and fails the
  overall run if any cleanup step fails;
- treats `E2E_OUTPUT_DIR` as an artifact root, creates and prints a unique child for
  every run, and never recursively deletes the caller-supplied root;
- writes `evidence.json` only after the browser journey, final PostgreSQL verifier,
  process/account/Stripe cleanup, and retained-artifact secret scan all pass; and
- removes the disposable database and local processes.

The runner builds and launches the directly tracked Next.js production process rather
than using `next dev` or an npm parent/child chain. Both build and HTTPS start run under
separate `env -i` allowlists. The build sees only public frontend settings plus a fixed
non-secret, non-public-name acknowledgement that enables its E2E-only route-auth mode;
neither process receives the Stripe secret key, webhook secret, database DSN, Personal
JWT, or workload JWT. This mode is accepted only for a production HTTP-mode build whose backend
is an HTTPS loopback origin, whose indexing flag is explicitly `false`, and which has no
browser credential. It compiles one fixed, deliberately invalid public sentinel into the
page. The Playwright Node helper itself runs under a separate `env -i` allowlist. It
holds the test key and database DSN for server-side
ownership/stability checks, and holds the one-run Personal JWT solely to replace
that exact sentinel on the attested backend origin's `/api/` requests. It fetches without
following redirects and fulfills the 30x back to Chromium, so a redirected request is
new and never inherits the real JWT. The helper never adds that JWT to Stripe,
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
artifact child remains at the printed path. Its mode-`0600` `evidence.json` binds the
run ID, Git commit and dirty flag, selected backend and transition policy, webhook
transport, request/Event API versions, and passed browser/database/cleanup statuses.
The file is written atomically from a strict allowlist and rescanned before success is
reported. On failure, no success evidence is written and the runner removes the
signing-secret state, JWT/JWKS files, and loopback private key. Before reporting either
success or failure it rewrites every retained service log and browser artifact through a
fail-closed scan for Stripe restricted/secret keys, webhook secrets, JWTs, Stripe client
secrets, database DSNs, and private keys, then verifies that none remain. The secret-free
cleanup manifest keeps exact recovery IDs when available. It never prints a matched
value, Stripe API key, signing secret, database credential, JWT, or card input.

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
or authentication subject. It therefore cannot run the full wrapper's in-memory
pre-projection barrier, final account/Invoice/five-essential-Event verifier, pack cash
refund, or automatic teardown. It still checks the exact pack Session and eventual
webhook-backed lot, but it cannot claim the stronger observed “return stayed at 1,000”
proof. Use a one-run subject and
isolated test database, then run the staging verification/cleanup procedure for the
exact Subscription, Customer, endpoint evidence, and unresolved incidents. For a
recovery manifest, final database/Event verification, and strict teardown, use
`scripts/run_browser_e2e.sh` instead.

Optional variables:

| Variable                        | Default                                  | Purpose                                                                                                  |
| ------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `E2E_WEBHOOK_TIMEOUT_MS`        | `180000`                                 | Account-projection deadline; 10–600 seconds                                                              |
| `E2E_CUSTOMER_EMAIL`            | `browser-checkout@example.test`          | Fills an editable Checkout email field                                                                   |
| `E2E_HEADLESS`                  | headless                                 | Set to `0` for local visual diagnosis                                                                    |
| `E2E_POSTGRES_IMAGE`            | `postgres:17-alpine`                     | Trusted PostgreSQL 17 image override for the full runner                                                 |
| `E2E_DECLINE_STABILITY_SECONDS` | `10`                                     | DB/Stripe decline barrier; 10–60 seconds                                                                 |
| `E2E_TRANSITION_POLICY`         | `full_period_reset` in the full runner   | Upgrade template; run both values for release evidence                                                   |
| `E2E_BACKEND_IMPLEMENTATION`    | `python`                                 | Backend runtime; accepts only `python` or `typescript`, and release evidence runs both                   |
| `E2E_UPGRADE_PAYMENT_METHOD`    | `pm_card_authenticationRequired`         | Allowlisted upgrade fixture; default exercises Stripe.js SCA                                             |
| `E2E_STORAGE_STATE`             | unset locally; required remotely         | Private mode-`0600` Playwright auth state for the exact isolated subject                                 |
| `E2E_WEBHOOK_TRANSPORT`         | `endpoint`                               | `endpoint` for release evidence or explicit `stripe_cli` signed forwarding for local diagnosis/recording |
| `E2E_RECORD_VIDEO`              | `0`                                      | Set to `1` to retain one Playwright video per page                                                       |
| `E2E_DEMO_PAUSE_MS`             | `0`                                      | Recording-only scene hold, 0–5,000 ms; assertions do not depend on it                                    |
| `E2E_OUTPUT_DIR`                | backend-and-policy-specific ignored root | Artifact root; the runner creates and prints a unique per-run child and never deletes the root           |

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

## Authentication environment boundary

The full runner generates the Personal and workload JWTs itself. It never asks the
operator to paste them, never gives the workload JWT to Playwright or Chromium, removes
both JWT files even when a run fails, and never stores the ephemeral RSA private key.
The following names document the isolated process boundaries; the runner supplies the
values rather than accepting them as public frontend configuration.

```text
Backend:
  APP_ENV=production
  STRIPE_SECRET_KEY=sk_test_...
  STRIPE_WEBHOOK_SECRET=whsec_...
  STRIPE_WEBHOOK_API_VERSION=<actual endpoint Event snapshot version>
  STRIPE_PORTAL_CONFIGURATION_ID=bpc_...
  CHECKOUT_SUCCESS_URL=<E2E_BASE_URL>/billing/success
  CHECKOUT_CANCEL_URL=<E2E_BASE_URL>/pricing
  PORTAL_RETURN_URL=<E2E_BASE_URL>/account
  FRONTEND_ORIGINS=<E2E_BASE_URL>
  E2E_PERSONAL_JWKS_FILE=<private temporary path containing public JWKS>
  E2E_JWT_ISSUER=<loopback HTTPS issuer>
  E2E_PERSONAL_JWT_AUDIENCE=<personal audience>
  E2E_WORKLOAD_JWT_AUDIENCE=<different internal audience>
  E2E_WORKLOAD_JWT=<short-lived server-only signed JWT>
  E2E_EXPECTED_OWNER_EXTERNAL_REF=v1:user:<personal JWT sub>
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
  E2E_PERSONAL_BEARER_TOKEN=<short-lived Personal JWT; full runner Node only>
  E2E_FULL_STACK_EVIDENCE=1                       # full runner only
  E2E_STORAGE_STATE=<private mode-0600 file; required for a remote origin>
```

The production frontend contains only the fixed invalid route-auth sentinel. Playwright
replaces it with the Personal JWT only on exact loopback backend `/api/` requests and
never on a redirect. A separately managed staging stack may omit the Personal token and
use `E2E_STORAGE_STATE` from its real host login instead; in that mode the repository
cannot expose the full runner's private workload/Job evidence route. The local issuer is
a deterministic adapter test fixture, not a deployable IdP. Production hosts must use
their own OIDC/session login, issuer, audience, key rotation, revocation, and workload
authorization policy.

## Failure diagnosis

- **Initial account is not Free:** use a new disposable database and unique subject.
  Browser retries are disabled because this is a stateful billing lifecycle.
- **Runner stops before the tunnel:** inspect the retained `migrate.log`; the runner
  separately checks container readiness and host-side database connectivity first.
- **Checkout returns 400/409:** verify exact allowlisted origins/paths, test catalog
  lookup keys, and whether an older unexpired Checkout owns the account claim.
- **No `/api/account` response:** inspect the HTTPS JWKS path, issuer/audience/sub claims,
  Personal token expiry, frontend HTTP mode, and CORS origin; mock mode is deliberately
  rejected by the initial-state assertion.
- **No decline message:** inspect Stripe's current Checkout DOM, failure screenshot, and
  sanitized private service logs; Stripe may have changed hosted copy or field structure.
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
- **Pack page stays at 1,000 after the barrier releases:** inspect the private gate and
  backend logs (never the payload), confirm `payment_intent.succeeded` is enabled, and
  check the immutable metadata/amount/currency contract. `checkout.session.completed`
  must not create a lot.
- **Pack cleanup refuses to refund:** keep the mode-`0600` recovery manifest. One of the
  Session → PaymentIntent → Charge → Customer/account/order checks drifted, so the runner
  intentionally left the Charge untouched instead of risking a cross-run refund.
- **Portal creation returns 502:** inspect whether the dedicated configuration still has
  plan updates disabled and period-end cancellation enabled. The gateway also rejects a
  Session whose object, `bps_` ID, Customer, configuration, return URL, or mode differs
  from the request; it does not fall back to the Dashboard default Portal.
- **Portal opens but cannot return:** inspect the failure screenshot and sanitized logs
  for Stripe's hosted return control, and confirm `PORTAL_RETURN_URL` is the exact
  frontend `/account` URL.
  Directly navigating back in the test would hide this contract failure and is not used.
- **Product Job returns 401/403/502:** distinguish Personal JWT failure on the host route
  from workload JWT/audience/scope failure and owner-authorizer denial on the internal
  route. The browser never receives the workload credential, and internal routes must
  remain outside browser CORS.
- **Final balance is not 1,020:** require one exact 80-credit successful debit and one
  exact 20-credit terminal debit/refund. Inspect debit allocations and `refunded_at`;
  changing the browser number without those PostgreSQL facts is not a fix.

Authenticated request traces are deliberately disabled: a Playwright trace can retain
the one-run Personal JWT injected by the Node harness. Playwright instead retains its
failure screenshot, unique HTML report, explicit redacted timeline, and optional video
under ignored `web/test-results/`; all are scanned before the runner reports their path.
Treat them as private test evidence because screenshots can still contain test customer
identifiers or the test email. Do not attach them unreviewed to public issues. Video is
created only when `E2E_RECORD_VIDEO=1`.

## Relationship to Test Clocks

A successful browser gate proves interactive Checkout, decline, SCA, signed delivery,
and UI projection in wall-clock time. Stripe Test Clocks are a separate lifecycle
harness for renewal and future boundaries. A clock belongs to a Customer from creation
time, so a normal Checkout-created Customer cannot be retroactively attached to a
clock. Do not describe this browser test as a renewal or time-travel test; run the
documented Test Clock scenarios independently and join the evidence only at the release
checklist.
