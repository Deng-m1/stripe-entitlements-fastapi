# First real deployment: Stripe test-mode staging

This is the shortest provider-neutral path from a fork, v0 project, or existing SaaS
application to a real Stripe test-mode deployment. It covers Python/FastAPI and native
TypeScript/Next.js. Use [Vercel](VERCEL.md) for provider-specific commands and
[Adoption](ADOPTION.md) for host identity, teams, Jobs, and service composition.

Test mode uses real Stripe-hosted Checkout, Customer Portal, SCA, signed webhooks, and
PostgreSQL projection without moving money. A browser-only simulation is useful for UI
review but is not a billing deployment.

## Ask these product questions once

An implementation agent should establish these choices before changing billing code.
Ask only the unanswered questions that change the result; do not turn known answers into
repeated approval gates.

1. Is the billable owner one person or one team? Which verified, immutable user or team
   ID will become `external_ref`?
2. Which one server runtime will own API, webhook, and worker traffic: Python/FastAPI or
   TypeScript/Node/Next.js?
3. Which plan keys, monthly/yearly prices, monthly credit grants, features, and limits
   belong in `plans.toml`?
4. Which upgrade policy should apply: `full_period_reset` or `prorated_delta`?
5. Are yearly subscriptions, one-time credit packs, and Customer Portal required?
6. Which identity provider, PostgreSQL 17 or 18 database, stable staging domain, and
   scheduler will the host use?
7. Is this a UI simulation, Stripe test staging, or an explicitly approved live-mode
   cutover?

Safe defaults for a new personal SaaS are native Next.js Node Route Handlers, personal
billing, Stripe test mode, Hosted Checkout, `full_period_reset`, yearly credits released
monthly, optional Portal cancellation at period end, no credit packs until the product
needs them, and a stable noindex staging domain.

## Understand the subscription mechanisms

This repository does not offer several unrelated subscription backends. It provides one
webhook-authoritative lifecycle with explicit entry and transition mechanisms:

| User action | Mechanism | When local access changes |
| --- | --- | --- |
| First paid subscription | Stripe Hosted Checkout in `subscription` mode | After the matching signed `invoice.paid` projection |
| Renewal | Stripe invoice and subscription Events | After the paid Invoice is projected |
| Immediate upgrade with `full_period_reset` | App preview/confirm; full target price, new period, no proration | After the matching paid settlement Invoice |
| Immediate upgrade with `prorated_delta` | App preview/confirm; same-period monthly higher tier, Stripe cash difference, fixed entitlement difference | After the matching paid settlement Invoice |
| Downgrade, annual-origin change, or unsupported interval change | App preview/confirm plus Subscription Schedule | At the scheduled period boundary and paid projection |
| Cancel | Dedicated Customer Portal, cancel at period end | At the applicable subscription/Invoice projection |
| One-time product credits | Hosted Checkout in `payment` mode | After the exact signed `payment_intent.succeeded` projection |

Portal price changes are intentionally disabled. Plan changes go through the application
preview/confirm API so the selected policy, source entitlement, Invoice, and recovery
state are durable. An annual saving is an explicit yearly Price in `plans.toml`, not a
Coupon. Coupons, tax, trials, quantities, seats, metered billing, and multi-currency
Invoices are outside the implemented contract.

## Know who owns what

| Boundary | Responsibility |
| --- | --- |
| Stripe | Hosted payment UI, Customers, Subscriptions, Invoices, PaymentIntents, Portal, and at-least-once Event delivery |
| This repository | Signed Event verification, local entitlement projection, exact credits, transition intent, idempotency, refunds/disputes, reconciliation, and annual grant workers |
| Host application | Login/session verification, personal or team ownership, business entities and Jobs, server-side feature/limit enforcement, and product-specific queue/outbox policy |
| Deployment platform | Server runtime, secret injection, stable HTTPS origin, Cron/scheduler invocation, logs, and scaling |
| PostgreSQL | Writable entitlement truth and cross-instance coordination; it still needs backups, pooling, and restore testing |
| Human operator | Product policy, account access, stable domain, live-mode authorization, and final production acceptance |
| Implementation agent | Source integration, migrations, test-mode bootstrap, Route Handlers, environment templates, preflight, and tests within the access it has been given |

Stripe does not grant application access, v0 does not replace a backend, and Vercel does
not replace PostgreSQL. The repository is not an identity provider and cannot diagnose a
failed host registration flow without the host's auth/database logs.

## Build a deployable source artifact

The current `0.4.0` candidate is not published to npm. Use one reviewed repository
commit, a pinned Git/local `file:` dependency, a complete vendor tree, or a locally
packed `.tgz`. Do not write a nonexistent registry package into `package.json`.

For a TypeScript source dependency, deployment must install its third-party dependencies
and run its build before Next.js starts. The checked-in `web/` build also relinks the
workspace package after generating `dist/`, so its CLI exists on a clean deployment
rather than only on a developer machine. Do not depend on an uncommitted developer-local
`dist/`. A verified `.tgz` already contains compiled JavaScript, `plans.toml`, and both
migrations. Exact source and vendor layouts are in
[Adoption](ADOPTION.md#consume-a-pinned-git-source-or-vendored-copy).

The catalog and migrations are runtime files rather than JavaScript imports. A standalone
Next.js host must retain this configuration:

```javascript
// next.config.mjs
const nextConfig = {
  outputFileTracingIncludes: {
    "/*": [
      "./node_modules/@tosea/stripe-entitlements/dist/plans.toml",
      "./node_modules/@tosea/stripe-entitlements/dist/migrations/**/*.sql",
    ],
  },
};

export default nextConfig;
```

The checked-in `web/` application includes this rule plus `../typescript/dist/...`
entries for its monorepo `file:` symlink. It fails its production build when the catalog
or any packaged migration is absent from the API, webhook, or health Route Handler trace.
A standalone application should use the `node_modules` entries shown above; a fork that
preserves this repository's `web/` + `typescript/` layout must keep both monorepo entries.
Leave `PLAN_CATALOG_PATH` unset to use the package copy. If the host uses a custom
catalog, include that exact deployed file in the trace; a path that exists only on the
developer's machine is not deployable.

## Use environment configuration, not source constants

Ignored `.env` and `.env.local` files are local inputs. Git and deployment platforms do
not upload them as application configuration. Put each value into the target platform's
environment/secret store and set it independently for staging and production.

Server-only secrets include:

- `DATABASE_URL`;
- `STRIPE_SECRET_KEY`;
- `STRIPE_WEBHOOK_SECRET`;
- `CRON_SECRET` when using the bundled HTTP scheduler routes; and
- identity-provider or workload-verification secrets owned by the host.

The publishable Stripe key may be browser-visible only as
`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`. Hosted Checkout and Portal redirects do not need
it; the complete reference plan-change/SCA UI does.

The following are not secrets, but they should still be environment-specific rather
than hardcoded in a shared `runtime.ts`: `STRIPE_PORTAL_CONFIGURATION_ID`, product line,
lookup prefix, transition policy, Checkout success/cancel URLs, Portal return URL, CORS
origins, canonical site URL, and indexing flag. Preview, staging, and production commonly
use different values.

## Deploy in two phases when the domain is new

An online Webhook Endpoint cannot be finalized until its stable HTTPS destination is
known. Prefer this order:

1. create/link the platform project and reserve its stable staging domain;
2. initialize an isolated PostgreSQL 17 or 18 database with the packaged migrations;
3. bootstrap the Stripe **test-mode** Products, Prices, and optional safe Portal
   configuration;
4. configure host authentication and all domain-dependent redirect/CORS values;
5. create the test-mode Webhook Endpoint for
   `https://staging.example.com/webhooks/stripe`;
6. place that endpoint's signing secret and actual signed-payload API version in the
   platform's server environment; and
7. deploy or redeploy the complete application, then run preflight and browser tests.

If a platform reveals its generated URL only after the first deployment, treat that
first deployment as a bootstrap artifact, not a ready billing site. The build may
complete, while billing initialization or `/health` remains unavailable until the real
endpoint secret is configured. Obtain the URL, create the endpoint, set its secret, and
redeploy before testing or sending traffic. Never invent a placeholder signing secret to
make a deployment appear ready.

Local `stripe listen` is different. It prints a temporary signing secret for that local
listener and forward URL; never copy it into staging or production. Each Dashboard
Webhook Endpoint has its own persistent signing secret. Test and live mode also have
separate Products, Prices, Portal configurations, endpoints, Events, keys, and signing
secrets.

Configure only these supported Event types:

```text
checkout.session.completed
checkout.session.expired
invoice.paid
invoice.payment_failed
customer.subscription.updated
customer.subscription.deleted
charge.refunded
charge.dispute.created
payment_intent.succeeded
```

`STRIPE_API_VERSION` pins outbound SDK requests. `STRIPE_WEBHOOK_API_VERSION` validates
the Event snapshot delivered by the endpoint. They are independent contracts and may
legitimately differ. Determine the webhook value from the exact endpoint and an actually
delivered, signature-verified payload, not from an unrelated Event API retrieval.

## Preflight and acceptance

Before browser testing:

1. run the packaged migration command against the target database;
2. run the matching Stripe bootstrap `--verify-only` command;
3. run `stripe-entitlements doctor`, adding the Portal profile and read-only Stripe
   network check when Portal is enabled;
4. build the production Next.js application and require the runtime-resource trace gate;
5. confirm `/health` reports the intended test mode, transition policy, and ready schema;
6. confirm an unauthenticated `/api/account` returns `401`; and
7. confirm a real host login maps to the expected immutable personal or team owner.

Then test one complete lifecycle on the stable staging origin: login, Hosted Checkout,
decline, 3DS/SCA, signed paid projection, selected upgrade behavior, Portal return and
period-end cancellation. Add annual Test Clock, credit-pack, Job charge/refund, and
reconciliation scenarios only when those features are enabled. A Checkout success page
is never entitlement evidence; wait until `/api/account` reflects the webhook projection.

## Diagnose the boundary before changing code

| Symptom | Usually belongs to | First check |
| --- | --- | --- |
| Build cannot resolve a `file:` dependency | Host/v0 packaging | The vendor/submodule is in deployment source and its build runs before Next.js |
| Build succeeds but catalog or migrations are missing at runtime | Next.js packaging | `outputFileTracingIncludes` and the built `.nft.json` files |
| Billing routes return `503` immediately after deployment | Runtime configuration | Platform server variables, packaged resources, migration readiness, and server logs |
| `/api/account` returns `401` | Host identity | A real Auth adapter/token; this is the correct reject-all default |
| Registration itself fails | Host application | Identity-provider callback, host user table, and host logs—not Stripe webhooks |
| Checkout succeeds but access never changes | Webhook/deployment | Endpoint URL, event selection, signing secret, Event snapshot version, delivery status, and incidents |
| Local webhooks work but staging does not | Environment boundary | A Dashboard endpoint secret replaced the temporary `stripe listen` secret |
| Portal fails while Checkout works | Optional Portal setup | Correct environment-specific Portal configuration and safe policy |
| Upgrade remains pending | Expected billing or payment state | Settlement Invoice, SCA/recovery URL, matching durable intent, and selected policy |
| Plan cards stay on “Loading account” | Host UI/API integration | Browser network response for `/api/account`, access token, 401/503 body, and server error hook |

Do not “fix” a correct `401` by trusting a browser account ID, or a missing webhook by
granting access from the success redirect. Those shortcuts remove the security and race
guarantees this project exists to provide.

## Production is a separate cutover

After test staging passes, create independent live Products/Prices, Portal configuration,
Webhook Endpoint, signing secret, keys, database, URLs, and monitoring. Use the explicit
live bootstrap acknowledgements, verify one low-risk live Checkout and signed production
payload, and keep live mode blocked from the automated object-creation suites. See
[Stripe CLI and production cutover](STRIPE_CLI.md#production-cutover) and
[Webhook verification](WEBHOOK_VERIFICATION.md).
