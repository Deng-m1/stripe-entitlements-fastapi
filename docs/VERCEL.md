# Deploy Next.js and FastAPI together on Vercel

Railway, Kubernetes, and a separately hosted API are optional. The repository includes
a stable Vercel Services deployment that builds the existing Next.js reference UI and
the existing Python billing core as two services in one Vercel project:

```text
one Vercel deployment and domain
├── frontend  web/                 Next.js
└── billing   vercel_app:app       FastAPI / Python Functions
      ├── /api/*
      ├── /webhooks/stripe
      ├── /health
      └── /api/cron/*
              │
              └── managed PostgreSQL primary
```

This is one deployment boundary, not a second billing implementation. Stripe mutation,
webhook projection, PostgreSQL locking, credit packs, fractional credits, refunds, and
plan transitions continue to use `stripe_entitlements`. The browser calls relative
same-origin `/api/...` paths. There is no public backend hostname to copy into the UI and
no cross-origin dependency.

PostgreSQL remains required. Vercel Functions are stateless compute and cannot replace
the database, Stripe, the identity provider, backups, or object storage for product
files. Use a managed PostgreSQL provider with TLS, connection limits suitable for
serverless traffic, point-in-time recovery, and a region close to the Vercel Functions.

## What the checked-in configuration does

[`vercel.json`](../vercel.json) declares stable Vercel Services:

- `/api/*`, `/webhooks/*`, and `/health` route to FastAPI;
- every other path routes to Next.js;
- annual grants run hourly at minute 7;
- subscription and credit-pack reconciliation runs every five minutes; and
- Python installs the `auth` extra needed by the personal JWT/JWKS starter.

Each Cron request is authorized with Vercel's `Authorization: Bearer $CRON_SECRET`
contract. The server compares it in constant time. A missing secret returns 503 and an
incorrect credential returns 401. Both jobs process bounded pages, return only aggregate
counts, and return 503 when any candidate needs retry. Account, Subscription, Invoice,
PaymentIntent, and credit-pack identifiers are never returned by these endpoints.

The database constraints and leases remain the concurrency authority. Overlapping Cron
invocations or a manually repeated request can race safely against one PostgreSQL
primary. One function invocation intentionally does not drain an unbounded backlog; the
next scheduled invocation continues it. Operate backlog and incident alerts rather than
raising the bounds until a function approaches its duration limit.

Vercel plan limits determine whether a five-minute Cron schedule and the required
function duration are available. The checked-in hourly and five-minute schedules require
Vercel Pro or Enterprise; Hobby permits Cron only once per day and will reject this
configuration during deployment. On Hobby, remove the two `crons` entries, keep the same
FastAPI deployment, and invoke the secured URLs from a scheduler that supports the
required cadence, or run the existing `stripe-entitlements grant-due` and `reconcile`
commands elsewhere. The FastAPI function has an explicit 60-second bound; tune batch
sizes before raising that limit within the selected plan's maximum.

## 1. Prepare test-mode Stripe and PostgreSQL

Do this before the first deployment. Migration and catalog bootstrap are operator jobs,
not request-time Functions:

```bash
cp .env.example .env
chmod 600 .env
uv sync --frozen --extra auth
uv run --env-file .env stripe-entitlements migrate
uv run --env-file .env python scripts/bootstrap_stripe.py
uv run --env-file .env python scripts/bootstrap_stripe.py --verify-only
uv run --env-file .env stripe-entitlements doctor --stripe-network
```

The database must be new for the released 0.3 schema lineage. Do not make application
startup apply migrations: concurrent Functions are not a schema-deployment mechanism.
Run the least-privilege migration command explicitly before traffic and before deploying
code that requires a later migration.

## 2. Configure production authentication

The Vercel entrypoint defaults to `RejectAllAuthAdapter`. A deployment can start, expose
health and receive signed webhooks, but every browser billing API remains unauthorized
until authentication is configured. Same-origin routing is not authentication.

For a personal-user SaaS whose identity provider emits asymmetric JWTs with UUID `sub`
claims, set:

```dotenv
BILLING_AUTH_MODE=personal_jwt
BILLING_JWT_ISSUER=https://identity.example.com/
BILLING_JWT_AUDIENCE=billing-api
BILLING_JWKS_URL=https://identity.example.com/.well-known/jwks.json
BILLING_JWT_ALGORITHMS=RS256
```

The issuer, exact audience, signature, algorithm, `kid`, `exp`, `nbf`, and canonical UUID
subject are verified by the existing JWT starter. Partial JWT configuration fails at app
construction instead of falling back to a weaker identity.

The browser still needs the matching identity-provider integration to supply its access
token through the [`AuthAdapter`](../web/lib/auth.ts). The reference deliberately does
not put a server secret, generic user header, or demo Bearer token in production browser
JavaScript. Replace `noAuthAdapter` in [`runtime.ts`](../web/lib/runtime.ts) with the host
provider's session/token adapter, or put a provider-aware same-origin BFF in front of the
billing API.

Team billing requires live membership and billing-role checks owned by the product.
Construct `TeamJwtAuthAdapter` with the product's `TeamMembershipRepository` and pass it
to `create_vercel_app(auth_adapter=...)` in a product-specific entrypoint. A signed tenant
claim by itself is never authorization.

## 3. Add Vercel environment variables

Create a Vercel project from the repository root and set its Framework Preset to
**Services**. Keep project Root Directory at the repository root. Use Vercel CLI 59.10.0
or newer for the checked-in stable Services configuration.

Set the following server variables for each environment:

```dotenv
DATABASE_URL=postgresql://...                         # managed PostgreSQL, TLS
STRIPE_SECRET_KEY=sk_test_...                         # test/staging only
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_API_VERSION=2026-06-24.dahlia
STRIPE_WEBHOOK_API_VERSION=2026-06-24.dahlia          # actual endpoint payload contract
STRIPE_PORTAL_CONFIGURATION_ID=bpc_...
PRODUCT_LINE=your-product
LOOKUP_PREFIX=your-prefix
PLAN_CATALOG_PATH=plans.toml
BILLING_TRANSITION_POLICY=full_period_reset
CHECKOUT_SUCCESS_URL=https://your-domain.example/billing/success
CHECKOUT_CANCEL_URL=https://your-domain.example/pricing
PORTAL_RETURN_URL=https://your-domain.example/account
FRONTEND_ORIGINS=https://your-domain.example
APP_ENV=production
CRON_SECRET=<at-least-16-random-visible-ASCII-characters>
```

Set these build-time public variables for the Next.js service:

```dotenv
NEXT_PUBLIC_BILLING_API_MODE=http
NEXT_PUBLIC_BILLING_API_BASE_URL=same-origin
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_...
NEXT_PUBLIC_SITE_URL=https://your-domain.example
NEXT_PUBLIC_ALLOW_INDEXING=true
```

`same-origin` is an explicit sentinel. An empty base URL is rejected, while the sentinel
produces relative `/api/...` requests and still requires a non-empty access token from a
real browser authentication adapter.

Use separate values by environment:

| Resource | Preview | Staging | Production |
| --- | --- | --- | --- |
| PostgreSQL | isolated disposable database | staging database | production HA database |
| Stripe key/catalog | test-mode isolated prefix | test mode | live mode |
| Webhook endpoint/secret | isolated test endpoint | stable test endpoint | new live endpoint |
| Portal configuration | test | test | independently bootstrapped live configuration |
| indexing | disabled | disabled | enabled only on the canonical domain |

Never point an arbitrary pull-request preview at the production database, live Stripe
key, or production webhook secret. Vercel Preview variables are shared unless you make
them branch-specific. If isolated preview state is not available, skip the full Services
preview or use a separate frontend-only mock preview; never make the FastAPI service boot
by lending it production resources. The repository's SEO configuration is fail-closed:
previews remain `noindex` unless both the canonical HTTPS site URL and the explicit
indexing flag are configured.

## 4. Register the Stripe webhook

Test and live modes need different endpoints, Products, Prices, Portal configurations,
and signing secrets. Register exactly:

```text
https://your-domain.example/webhooks/stripe
```

Subscribe only to the supported Events listed in
[`ARCHITECTURE.md`](ARCHITECTURE.md#supported-webhook-event-contract). Inspect the exact
Webhook Endpoint and an actually delivered, signature-verified payload before setting
`STRIPE_WEBHOOK_API_VERSION`. The outbound request version is a separate setting.

For local development, keep using Stripe CLI forwarding:

```bash
stripe listen \
  --events checkout.session.completed,checkout.session.expired,invoice.paid,invoice.payment_failed,customer.subscription.updated,customer.subscription.deleted,charge.refunded,charge.dispute.created,payment_intent.succeeded \
  --forward-to http://127.0.0.1:3000/webhooks/stripe
```

The forwarding URL uses the single Vercel development origin; its routing table sends
the request to FastAPI.

## 5. Run the complete deployment locally

Install the pinned CLI and run both services through the real routing table:

```bash
npx vercel@59.10.0 dev -L
```

`-L` uses local configuration without linking or deploying a cloud project. It still
needs the same environment variables and a reachable migrated PostgreSQL database. Test
through the public local origin, not the internal FastAPI port:

```bash
curl --fail http://127.0.0.1:3000/health
curl -i http://127.0.0.1:3000/api/account
curl -i -H "Authorization: Bearer $CRON_SECRET" \
  http://127.0.0.1:3000/api/cron/reconcile
```

The unauthenticated account request must be 401. Do not paste actual keys or Cron secrets
into terminal history on shared machines; the commands above use environment expansion
only as a schematic example.

## 6. Deploy and verify

Link and deploy after the environment matrix is configured:

```bash
npx vercel@59.10.0 link
npx vercel@59.10.0 deploy
# after preview verification
npx vercel@59.10.0 deploy --prod
```

Verify the deployed commit as one system:

1. `/health` reports a ready schema and expected Stripe mode/policy.
2. A protected API rejects a missing or invalid identity token.
3. The identity provider token resolves the expected immutable personal/team owner.
4. Hosted Checkout returns to the same deployment, but access changes only after the
   signed webhook projection.
5. Cron logs show bounded successful count summaries and no identifiers/secrets.
6. Reconciliation and annual scheduler lag remain within the operational threshold.
7. The complete browser Stripe test-mode gate passes against the preview or staging URL.

Vercel local development proves service discovery and routing but is not production
evidence. A Preview Deployment proves the built Services artifact. Stripe CLI forwarding
proves signed local transport. A configured Webhook Endpoint and its delivered payload
prove endpoint transport. None of those by itself proves live-mode production behavior;
keep the evidence layers separate as described in [`TESTING.md`](TESTING.md).

## Platform boundary

The FastAPI service is safe across multiple warm instances because correctness lives in
PostgreSQL, not process memory. Cold starts and function termination can still interrupt
a request; Stripe retries webhook 5xx, callers replay durable idempotency keys, and Cron
returns a retryable failure. Configure database pool/connection limits for concurrent
Functions and monitor saturation.

Long-running conversion, video, AI, or file-processing jobs should not be placed inside
these billing Functions merely because the frontend is on Vercel. Keep product work in
the host's queue/worker platform, use object storage for inputs/outputs, and use the
owner-authorized entitlement/charge/refund API plus an outbox/fencing workflow. Vercel
Services removes an unnecessary web-host dependency; it does not turn Stripe,
PostgreSQL, or product jobs into one distributed transaction.
