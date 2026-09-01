# Stripe Billing, Entitlements & Credit Packs for TypeScript and FastAPI

**English** | [简体中文](README.zh-CN.md)

[![CI](https://github.com/ToseaAI/stripe-entitlements/actions/workflows/ci.yml/badge.svg)](https://github.com/ToseaAI/stripe-entitlements/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Python](https://img.shields.io/badge/python-3.12%2B-3776AB.svg)](pyproject.toml)
[![Node](https://img.shields.io/badge/node-22%2B-339933.svg)](typescript/package.json)

Add Stripe subscriptions, product entitlements, exact usage credits, and one-time
credit packs to a SaaS product without designing the accounting workflow from scratch.
Choose a native TypeScript/Node/Next.js backend or a Python/FastAPI backend; both use
PostgreSQL and the same customer-facing billing rules.

The reference covers the parts that a Checkout-only example leaves to the product:
when access starts, how upgrades and downgrades behave, how yearly credits are released,
what refunds remove, and how duplicate or out-of-order webhooks converge safely.

> Independent community project; not an official Stripe product or financial, tax,
> accounting, or legal advice.

> **Release status:** `main` contains the v0.4 release candidate, but the v0.4 tag and
> public npm package are not published yet. Use a pinned Git dependency, vendored source,
> or a locally built tarball. This is a pre-1.0 reference with no documented third-party
> production adopters; the evidence described below is Stripe test-mode evidence.

## Start here

| What you are building | Recommended entry point |
| --- | --- |
| Next.js, Node, or another TypeScript server | [Native TypeScript guide](typescript/README.md#requirements) |
| Python API or an existing FastAPI service | [Quick start](#quick-start), then [adoption guide](docs/ADOPTION.md#compose-the-fastapi-application) |
| A real Stripe test-mode staging deployment | [First deployment guide](docs/DEPLOYMENT.md) |
| A shareable UI-only prototype without Stripe or a database | [AI builder simulation](docs/AI_BUILDERS.md#publish-a-ui-only-simulation) |

You normally deploy **one** billing backend. These directories make both supported paths
explicit:

```text
src/stripe_entitlements/   native Python/FastAPI backend
typescript/src/            independent native TypeScript/Node backend
typescript/src/next/       Next.js App Router adapter
web/app/                   SSR reference UI and server routes
```

The [pinned Git and minimum vendoring guide](docs/ADOPTION.md#consume-a-pinned-git-source-or-vendored-copy)
lists the exact source, SQL, catalog, build, and upgrade boundaries for using the project
before registry packages are available.

## Contents

- [What this gives your product](#what-this-gives-your-product)
- [How the business flow works](#business-flow)
- [Choose TypeScript or Python](#choose-runtime)
- [Plans and credit packs](#plan-catalog)
- [Choose an upgrade policy](#plan-transitions)
- [Why adoption is fast](#quick-adoption)
- [Quick start](#quick-start)
- [Connect it to an existing product](#adoption)
- [Deployment essentials](#deployment-essentials)
- [Evidence](#evidence)
- [Limits](#limitations)
- [FAQ](#faq)

## What this gives your product

| Product need | Included behavior |
| --- | --- |
| Sell subscriptions | Stripe Hosted Checkout for monthly and yearly plans |
| Turn payment into access | Signed paid-Invoice webhooks project the active plan and entitlements into PostgreSQL |
| Offer upgrades | Choose full-price restart or same-period prorated-difference behavior |
| Offer downgrades and cancellation | Schedule safe period-end changes; use a restricted Customer Portal |
| Give usage credits | Exact balances down to `0.000001`, with atomic charge and refund operations |
| Sell top-ups | One-time credit packs with source-aware expiry, refunds, disputes, and reconciliation |
| Support annual plans | Charge yearly while releasing product credits in monthly slots |
| Recover failed payments | Keep the last paid entitlement until a new Invoice actually succeeds |
| Integrate product authorization | Personal/team auth adapters plus server-side entitlement and credit services |
| Show a working account experience | Next.js pricing, account, Checkout return, Portal, and payment-recovery screens |

The bundled catalog is an example, not a framework restriction: the parser accepts
any non-empty set of stable plan keys and zero or more card-funded one-time USD credit
packs. The bundled reference catalog ships three subscription tiers and three packs.

<a id="business-flow"></a>

## How the business flow works

```text
Customer chooses a plan
        ↓
Stripe Hosted Checkout collects payment
        ↓
Signed webhook confirms the paid Invoice
        ↓
PostgreSQL records plan, entitlements, credits, and idempotency
        ↓
Your server checks entitlement or charges credits before doing product work
```

The browser redirect is never proof of payment. Stripe owns payment collection; this
project owns the local billing projection; your application owns login, team membership,
business records, and enforcement.

| Customer action | Product behavior |
| --- | --- |
| First subscription | Checkout starts access only after the matching paid Invoice is processed |
| Immediate upgrade | Preview the price, confirm it, handle SCA if needed, then switch only after payment |
| Downgrade or cancellation | Keep the paid plan until period end |
| Monthly renewal | Replace the monthly subscription-credit pool from the paid renewal Invoice |
| Yearly renewal | Keep yearly billing while granting up to 12 monthly credit slots |
| Buy a credit pack | Add credits only after the exact one-time PaymentIntent succeeds |
| Refund or dispute | Remove value from the original funding source and retain debt if already spent |

Before coding, decide five things: who owns billing (a person or a team), which runtime
you deploy, which plans and entitlements exist, which upgrade policy you want, and
whether you need yearly billing, packs, Portal, and scheduled workers. The
[first deployment guide](docs/DEPLOYMENT.md) turns those answers into a concrete setup.

<a id="choose-runtime"></a>

## Choose TypeScript or Python

Both are server-side implementations; TypeScript is not a browser client or a proxy to
Python.

| Choose | Best fit | Main integration surface |
| --- | --- | --- |
| TypeScript / Node / Next.js | Next.js App Router, a Node service, or another Fetch-compatible host | `BillingKernel`, Fetch handler, Route Handler adapter, Node CLI |
| Python / FastAPI | Existing Python API, standalone service, container, or sidecar | `BillingKernel`, `install_billing`, `EntitlementService`, Python CLI |

Both read the same [`plans.toml`](plans.toml), apply the same PostgreSQL migrations, and
follow the same transition matrices. Pick the language already used by the server that
owns authentication and product authorization.

<a id="plan-catalog"></a>

## Plan catalog

The example catalog makes the business model visible before integration. Replace the
names, Stripe lookup keys, prices, credits, features, and limits with your own values.
Stable plan rank—not price—decides whether a move is an upgrade or downgrade.

| Plan | Monthly | Yearly total | Yearly equivalent | Annual saving | Monthly credits |
| --- | ---: | ---: | ---: | ---: | ---: |
| Starter | $19 | $137 | $11.42/mo | $91 | 300 |
| Pro | $49 | $353 | $29.42/mo | $235 | 1,000 |
| Ultra | $149 | $1,073 | $89.42/mo | $715 | 4,000 |

| Entitlement | Starter | Pro | Ultra |
| --- | ---: | ---: | ---: |
| PDF/image → PowerPoint | yes | yes | yes |
| Batch conversion | no | yes | yes |
| API access | no | yes | yes |
| Priority queue | no | no | yes |
| Maximum file size | 30 MB | 100 MB | 250 MB |
| Maximum pages per job | 100 | 500 | 2,000 |
| Concurrent jobs | 1 | 5 | 20 |
| API keys | 0 | 5 | 25 |

Yearly savings are display information only. A yearly price may be lower, equal to, or
higher than 12 monthly payments; the UI claims a saving only when it is truly lower.
Yearly customers still receive credits monthly rather than receiving all 12 slots at
purchase.

The [adoption guide](docs/ADOPTION.md#customize-the-catalog-deliberately) explains how to
validate the catalog and refresh the public pricing snapshot with either runtime.

<a id="credit-packs"></a>

## One-time credit packs

| Pack | Price | Credits | Default expiry |
| --- | ---: | ---: | ---: |
| Boost 100 | $15 | 100 | 365 days |
| Boost 500 | $59 | 500 | 365 days |
| Boost 2,000 | $199 | 2,000 | 365 days |

Packs add spendable credits but never change a subscription tier, features, or limits.
The reference uses card-only Hosted Checkout, grants from the exact successful
PaymentIntent, spends the oldest-expiring source first, and traces partial/full refunds
and disputes back to that source. See [Credit packs](docs/CREDIT_PACKS.md).

<a id="plan-transitions"></a>

## Choose an upgrade policy: two complete 6 × 6 matrices

The six states are Starter, Pro, and Ultra in monthly or yearly billing. Read each table
from the customer's **current plan on the left** to the **target plan at the top**:

- **Now — full price:** collect the target price and start a fresh target period.
- **Now — prorated difference:** keep the monthly period and collect Stripe's net
  remaining-period difference.
- **At period end:** keep today's paid entitlement and schedule the change.
- **—:** no change.

Set `BILLING_TRANSITION_POLICY=full_period_reset` for Template A or
`BILLING_TRANSITION_POLICY=prorated_delta` for Template B.

### Template A — simple full-price restart

Use this when immediate upgrades should be easy to explain: the customer pays the full
target price now, starts a new target period, and receives the target credit pool after
payment.

| Current plan ↓ / Target plan → | Starter<br>monthly (SM) | Starter<br>yearly (SY) | Pro<br>monthly (PM) | Pro<br>yearly (PY) | Ultra<br>monthly (UM) | Ultra<br>yearly (UY) |
| --- | --- | --- | --- | --- | --- | --- |
| **Starter monthly (SM)** | — | **Now**<br>full price | **Now**<br>full price | **Now**<br>full price | **Now**<br>full price | **Now**<br>full price |
| **Starter yearly (SY)** | **At period end** | — | **At period end** | **At period end** | **At period end** | **At period end** |
| **Pro monthly (PM)** | **At period end** | **At period end** | — | **Now**<br>full price | **Now**<br>full price | **Now**<br>full price |
| **Pro yearly (PY)** | **At period end** | **At period end** | **At period end** | — | **At period end** | **At period end** |
| **Ultra monthly (UM)** | **At period end** | **At period end** | **At period end** | **At period end** | — | **Now**<br>full price |
| **Ultra yearly (UY)** | **At period end** | **At period end** | **At period end** | **At period end** | **At period end** | — |

### Template B — common prorated monthly upgrade

Use this when a customer moving to a higher monthly tier should pay only for the
remaining-period difference. Month/year conversions, downgrades, and every change from
an annual plan wait until period end.

| Current plan ↓ / Target plan → | Starter<br>monthly (SM) | Starter<br>yearly (SY) | Pro<br>monthly (PM) | Pro<br>yearly (PY) | Ultra<br>monthly (UM) | Ultra<br>yearly (UY) |
| --- | --- | --- | --- | --- | --- | --- |
| **Starter monthly (SM)** | — | **At period end** | **Now**<br>prorated difference | **At period end** | **Now**<br>prorated difference | **At period end** |
| **Starter yearly (SY)** | **At period end** | — | **At period end** | **At period end** | **At period end** | **At period end** |
| **Pro monthly (PM)** | **At period end** | **At period end** | — | **At period end** | **Now**<br>prorated difference | **At period end** |
| **Pro yearly (PY)** | **At period end** | **At period end** | **At period end** | — | **At period end** | **At period end** |
| **Ultra monthly (UM)** | **At period end** | **At period end** | **At period end** | **At period end** | — | **At period end** |
| **Ultra yearly (UY)** | **At period end** | **At period end** | **At period end** | **At period end** | **At period end** | — |

Example: Starter Monthly → Pro Monthly keeps the current period, asks Stripe for the
cash difference, and adds `1,000 - 300 = 700` product credits only after the matching
Invoice is paid. Exact Invoice acceptance, SCA, refund, and fail-closed behavior lives in
[Plan transition policies](docs/PLAN_TRANSITIONS.md).

<a id="quick-adoption"></a>

## Why adoption is fast

The repository supplies the reusable billing boundary; your product supplies its own
identity and business logic.

| Already provided | You connect |
| --- | --- |
| Checkout, Portal, catalog, account, preview, confirm, and webhook routes | Your login/session and person-or-team identity |
| PostgreSQL migrations and transactional ledger | Your managed PostgreSQL 17 or 18 database |
| Plan catalog, transition policy, credits, packs, refunds, and workers | Your prices, features, limits, URLs, and Stripe test account |
| `EntitlementService` and atomic charge/refund APIs | The product action that consumes an entitlement or credits |
| Next.js reference UI and browser API contract | Your branding or existing frontend |
| Auth starters, Vercel adapters, Docker path, and deployment guides | Your hosting, secrets, backups, and scheduler |

This keeps the integration surface small: map one verified user or team identifier,
configure the catalog, run the schema, mount one backend, and enforce the returned
entitlements from the server. You do not need to make your product entities depend on
Stripe Customer IDs or query the internal accounting tables directly.

The reason to trust the fast path is not its line count. Both runtimes share executable
policy vectors and database invariants; browser journeys exercise real Stripe test-mode
Hosted Checkout, SCA, signed webhooks, Portal, upgrades, and recovery. The concise
summary is under [Evidence](#evidence), with reproducible commands in
[Testing](docs/TESTING.md).

<a id="quick-start"></a>

## Quick start

Use a Stripe **test-mode** account and a disposable PostgreSQL database first. Clone the
source while the registry release is pending:

```bash
git clone https://github.com/ToseaAI/stripe-entitlements.git
cd stripe-entitlements
```

### Python / FastAPI

```bash
cp .env.example .env
chmod 600 .env
docker compose up -d postgres
uv sync --frozen
uv run --env-file .env stripe-entitlements migrate
uv run --env-file .env stripe-entitlements doctor
uv run --env-file .env \
  uvicorn stripe_entitlements.app:create_app --factory --port 8000
```

### TypeScript / Node

For contributors running this source checkout instead:

```bash
cd typescript
npm ci
npm run build
cp .env.example .env
chmod 600 .env
set -a
. ./.env
set +a
npx --no-install stripe-entitlements migrate
npx --no-install stripe-entitlements doctor
npx --no-install stripe-entitlements serve
```

The TypeScript build step creates the local CLI. For a separate application, follow the
[source, Git vendor, or tarball instructions](typescript/README.md#requirements) instead
of expecting the unpublished npm package.

These commands start the billing skeleton; real Checkout additionally needs your Stripe
test catalog, a signed webhook, authentication, and safe URLs. Follow
[First deployment](docs/DEPLOYMENT.md) rather than guessing those boundaries.

`stripe-entitlements migrate` initializes this application's schema. It does **not** upgrade PostgreSQL 17 to PostgreSQL 18; both PostgreSQL 17 or 18 can host a fresh schema.
Existing application-schema upgrades are documented in [Operations](docs/OPERATIONS.md).

<a id="adoption"></a>

## Connect it to an existing product

1. **Choose the billing owner.** Map an immutable ID from your identity provider to a
   person or verified team. Do not use email or a browser-supplied account ID as ownership.
2. **Mount one backend.** Compose `BillingKernel` with FastAPI or create the native
   TypeScript runtime/Next.js Route Handlers.
3. **Configure the product.** Replace the example plans, entitlements, prices, packs,
   transition policy, and redirect URLs.
4. **Apply the schema and connect Stripe.** Use a test database and Stripe test mode,
   then create the signed webhook endpoint after the staging domain exists.
5. **Enforce on the server.** Check an entitlement or atomically charge credits before
   starting product work; refund the operation idempotently when appropriate.
6. **Run the relevant gates.** Test your auth mapping, product routes, browser flow,
   failure recovery, and webhook delivery before considering live mode.

The public browser API is intentionally small:

| Route | Use |
| --- | --- |
| `GET /api/catalog` | Render server-controlled prices and entitlements |
| `GET /api/account` | Read the webhook-projected plan, credits, and pending state |
| `POST /api/checkout` | Start the first subscription |
| `POST /api/credit-packs/checkout` | Buy a one-time credit pack |
| `POST /api/billing/portal` | Open the restricted Customer Portal |
| `POST /api/billing/change/preview` | Preview a supported plan change |
| `POST /api/billing/change/confirm` | Confirm the opaque preview and handle payment |

Every mutation has an idempotency boundary. Production auth defaults to deny access
until you provide a verified adapter. Product routes use `EntitlementService` or the
protected internal API; they should not edit billing tables.

Complete personal/team identity examples, FastAPI composition, Next.js setup, product
credit workflows, and host contract tests are in [Adopting the reference](docs/ADOPTION.md).

## Deployment essentials

Real deployment is a two-phase process because the permanent Stripe webhook endpoint
needs the final HTTPS domain:

1. deploy the app and PostgreSQL schema to obtain the stable staging domain;
2. create the Stripe test-mode Webhook Endpoint for that domain, then add its own
   `STRIPE_WEBHOOK_SECRET` and actual `STRIPE_WEBHOOK_API_VERSION` to the deployment.

`stripe listen` is useful for local forwarding, but its temporary signing secret is not
the deployed endpoint's secret. Hosted Checkout and Portal redirects do not need a
publishable key; browser-side Stripe.js confirmation for upgrade/SCA does.

At minimum, the runtime needs PostgreSQL, a Stripe secret key, the permanent endpoint's
signing secret and webhook API version, safe redirect/origin URLs, and real auth. Portal
needs its restricted configuration ID; annual grants and reconciliation need a
scheduler. See [Deployment](docs/DEPLOYMENT.md), [Stripe CLI](docs/STRIPE_CLI.md), and
[Vercel options](docs/VERCEL.md).

<a id="correctness-model"></a>

## Correctness model

Stripe may deliver the same event more than once, deliver related events out of order,
or succeed remotely while an API response is lost. The implementation uses signed raw
payload verification, PostgreSQL transactions, locks, uniqueness constraints, durable
operation identities, and reconciliation so those cases converge without granting from
a browser return.

It claims at-least-once delivery with effectively-once PostgreSQL effects—not impossible
end-to-end exactly-once delivery. Multiple API and worker instances may share one
PostgreSQL primary with identical configuration. That database remains stateful
infrastructure and needs HA, backups, and tested restore. See
[Architecture](docs/ARCHITECTURE.md), [Invariants](docs/INVARIANTS.md), and
[Distributed deployment](docs/DISTRIBUTED.md).

<a id="evidence"></a>

## Evidence: what has actually been exercised

The repository's automated gates cover:

- both Python and native TypeScript implementations plus their shared policy vectors;
- real PostgreSQL transactions, duplicate and out-of-order events, concurrent workers,
  refunds, disputes, annual grants, and idempotent charge/refund behavior;
- clean package, migration, container, Next.js production-build, and simulation paths;
- opt-in real Stripe **test-mode** object-shape tests for subscriptions, packs, refunds,
  failed payments, prorated and full-price upgrades, and annual Test Clock renewal; and
- real production-build browser journeys in Stripe test mode covering Hosted Checkout,
  decline, 3DS/SCA, signed webhooks, account projection, Portal, plan change, and cleanup.

This is evidence of the repository's bounded contract, not proof that an adopter's auth,
catalog, hosting, scheduler, or live Stripe account is correct. The commands, exact
coverage, and current evidence boundary live in [Testing](docs/TESTING.md) and
[Browser E2E](docs/BROWSER_E2E.md). No live-production webhook payload verification is
claimed.

<a id="migrations"></a>

## Database schema and upgrades

Fresh PostgreSQL 17 or 18 databases apply the ordered application migrations. Existing
v0.3 application databases have an explicit v0.4 cutover; this is a schema change, not a
PostgreSQL server upgrade. Quiescing rules, backups, mixed-version restrictions, and
rollback boundaries belong in [Operations](docs/OPERATIONS.md), not in this homepage.

<a id="limitations"></a>

## Honest limits

The implemented reference is deliberately bounded to one subscription item and one
currency (USD), monthly/yearly plans, card-funded packs, and the two matrices above. It
does **not** currently implement seats or quantities, trials, coupons/promotion codes,
tax calculation, metered billing, multi-currency, arbitrary mixed Invoice items, revenue
recognition, or a hosted identity provider.

Discounted or unknown Invoice shapes fail closed rather than guessing. Your product must
still provide authentication, enforce features and limits, operate PostgreSQL, schedule
workers, monitor incidents, and validate its own live-mode configuration.

<a id="repository-map"></a>

## Repository map

| Path | Purpose |
| --- | --- |
| `src/stripe_entitlements/` | Python/FastAPI billing backend |
| `typescript/` | Native TypeScript/Node backend, Next.js adapters, and package guide |
| `web/` | Next.js reference product UI and SSR routes |
| `migrations/` | Ordered PostgreSQL application schema |
| `plans.toml` | Plans, prices, credits, features, and limits |
| `examples/` | Personal/team auth and Job/outbox integration examples |
| `docs/` | Adoption, deployment, policy, testing, and operations details |

<a id="faq"></a>

## Frequently asked questions

### Can I use this in a pure Next.js or SSR application?

Yes. Native Next.js Route Handlers are the backend, so a separate FastAPI or Railway
service is optional. Real billing still needs PostgreSQL because Stripe processes money
but does not store your application's entitlement ledger, usage balance, idempotency,
or workflow state.

### Is a Stripe test account enough to evaluate it?

Yes. Test mode supports Hosted Checkout, Portal, test cards, SCA, signed webhooks,
refunds, disputes, and Test Clocks without moving real money. Use isolated test resources;
the real-Stripe gates reject live secret keys.

### Can I use it before the npm package is published?

Yes. Python can use a pinned Git dependency or vendored source. TypeScript can use a
pinned checkout/local `file:` dependency or a locally built tarball. Follow the
[adoption guide](docs/ADOPTION.md) so source, migrations, catalog, and package resources
stay on the same version.

### What happens when an upgrade payment fails?

The customer keeps the last paid entitlement. The target plan becomes active only when
the matching Invoice is paid; recovery can continue through Stripe's hosted flow and
the account page.

### Are yearly plans just monthly price × 12?

No. The yearly total is an explicit catalog price. It can be discounted independently,
while product credits are still released in monthly slots.

### Can product work use fractional credits?

Yes. One credit equals one million integer atoms. Authoritative balances never use
binary floating point; APIs return exact decimal and atom strings. See
[Credit precision](docs/CREDIT_PRECISION.md).

## License

Apache-2.0. See [LICENSE](LICENSE).
