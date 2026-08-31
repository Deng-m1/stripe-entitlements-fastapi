# Use this project with v0, Lovable, or another AI app builder

Stripe test mode is enough to publish a realistic, access-controlled billing staging
site. It uses the real
Stripe API, Stripe-hosted Checkout and Portal pages, test cards, SCA, signed webhooks,
refunds, and Test Clocks. It does not move money and cannot prove merchant activation,
payouts, live-mode payment methods, or a production webhook payload.

An AI builder can generate the product UI, but it does not remove the server boundary.
`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, PostgreSQL credentials, Checkout Session
creation, webhook verification, and entitlement projection must remain in trusted
server-side code.

## Choose the evidence level

| Mode            | Stripe/PostgreSQL                                  | What a visitor sees                                                           | Use it for                                                |
| --------------- | -------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------- |
| `simulation`    | none                                               | Browser-local plan, credit-pack, upgrade, and success-state simulation        | Public GitHub demo, visual review, v0/Lovable layout work |
| test staging    | real Stripe **test mode** plus isolated PostgreSQL | Real `checkout.stripe.com`, Portal, SCA/declines, and webhook-projected state | Controlled product acceptance and browser E2E             |
| live production | real Stripe live mode plus production PostgreSQL   | Real cards, money, refunds, and payouts                                       | Approved production cutover only                          |

Never describe `simulation` as a Stripe E2E test. Never describe test staging as proof of
live settlement.

## Before an AI agent edits the product

The agent should first ask only for unanswered choices that change the implementation:

- personal or team billing, and the verified immutable owner ID;
- Python/FastAPI or native TypeScript/Next.js as the one billing runtime;
- plan prices, monthly credit grants, features, limits, yearly billing, and credit packs;
- `full_period_reset` or `prorated_delta` for immediate upgrades;
- identity provider, PostgreSQL database, stable staging domain, Portal, and scheduler;
  and
- UI simulation, Stripe test staging, or explicitly approved live production.

The agent should state its selected defaults before editing when the product brief does
not answer them. It may automate source integration, migrations, test-mode catalog
bootstrap, Route Handlers, environment templates, and verification with the credentials
and platform access it has been given. It must not invent a production domain, identity
contract, live-mode approval, or signing secret.

Use the provider-neutral [first real deployment guide](DEPLOYMENT.md) as the handoff
contract. It explains the subscription mechanisms, host/Stripe/repository responsibility
boundary, two-phase domain and webhook setup, Next.js runtime-resource tracing, and a
symptom-to-owner diagnosis table. That distinction matters with generated applications:
a host registration failure is not a Stripe bug, while a successful Checkout with no
projected access usually is a webhook/configuration problem.

## Publish a UI-only simulation

The reference frontend has a browser-local simulation mode for a public design/demo
link. It displays a simulation warning and never contacts Stripe or the billing backend.

Deploy only [`vercel.simulation.json`](../vercel.simulation.json) with these public
variables:

```dotenv
NEXT_PUBLIC_BILLING_API_MODE=simulation
NEXT_PUBLIC_SIMULATION_ACKNOWLEDGEMENT=1
NEXT_PUBLIC_ALLOW_INDEXING=false
```

Keep the Vercel root at the repository root. Do not add Stripe, database, auth, or Cron
credentials to this frontend-only project:

```bash
npx vercel@59.10.0 -A vercel.simulation.json deploy
# after verifying the Preview URL
npx vercel@59.10.0 -A vercel.simulation.json deploy --prod
```

Run `cd web && npm run test:e2e:simulation` before sharing it. For a deployed URL, set
`SIMULATION_BASE_URL` and `SIMULATION_ALLOW_REMOTE=1`. This proves the simulation stays
`noindex` and makes no Stripe/API request; it does not prove hosted Checkout, SCA,
webhooks, or money movement. Deployment/configuration details are in
[Vercel](VERCEL.md#frontend-only-public-simulation).

## Publish a real Stripe test-mode staging site

Use one stable HTTPS staging origin rather than a changing pull-request URL:

```text
browser
  -> v0/Next.js or Lovable UI
  -> authenticated billing API (Node/Next.js or FastAPI)
  -> isolated PostgreSQL

Stripe test mode
  -> https://billing-staging.example.com/webhooks/stripe
```

Provision separate staging resources:

1. a managed PostgreSQL 17 or 18 database initialized with migrations 001 and 002;
2. one Stripe test-mode catalog and safe test Portal configuration;
3. `sk_test_...` only on the server and `pk_test_...` only where Stripe.js needs it;
4. one test-mode Webhook Endpoint and its server-only `whsec_...`;
5. a real test identity provider, such as Supabase or Clerk;
6. a stable HTTPS origin for Checkout success/cancel, Portal return, CORS, and webhook
   delivery; and
7. a scheduler for annual grants and reconciliation.

Hosted Checkout and Portal redirects do not require a publishable key. This reference
also confirms some plan-change/SCA flows with Stripe.js, so its complete UI needs the
matching `pk_test_...` in browser configuration; secret and webhook keys remain
server-only.

Keep staging access-controlled and `noindex`. Do not share its database, Stripe catalog,
endpoint, or auth subjects with production or arbitrary previews. Follow the
[Vercel runbook](VERCEL.md) for environment variables, migrations, schedules, and
deployment checks.

## Lovable + Supabase

Lovable commonly owns a Vite UI and Supabase session. Its browser can call a separately
deployed Node/FastAPI billing service; a Vite app cannot run the Next.js Route Handlers.
The `@tosea/stripe-entitlements` package is server-only and currently unpublished, so do
not install or import it into a Vite browser bundle. The repository's `web/lib/*` files
are private to the reference Next.js UI; they are not package exports.

The generic JWT starter verifies a fixed issuer and audience, asymmetric signature,
required integer `exp`, required bounded stable `sub`, and optional integer `nbf` when
present. That shape covers UUID and opaque provider subjects, but a provider token may
still use a different audience, session-cookie flow, or organization claim. Use a
provider-specific server adapter or a same-origin HttpOnly-cookie BFF unless an
integration test proves the generic contract. Never use email as ownership authority.

For a separate Lovable/Vite project, copy the dependency-free
[`vite-billing-client.ts`](../examples/browser_adapters/vite-billing-client.ts) file into
that project's `src/` directory. It has no repository alias or package dependency. Wire
the host project's existing Supabase client into it with relative imports:

```typescript
// src/billing.ts in the Lovable/Vite project
import { createBillingFetch } from "./vite-billing-client";
import { supabase } from "./supabase"; // This is the host project's existing client.

export const billingFetch = createBillingFetch({
  baseUrl: import.meta.env.VITE_BILLING_API_URL,
  async getAccessToken() {
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;
    return data.session?.access_token ?? null;
  },
});
```

For Checkout, create one idempotency key when the user starts the action, retain it for
retries of that same action, and pass it to the copied transport:

```typescript
const checkoutIntentKey = crypto.randomUUID();
const { url } = await billingFetch<{ url: string }>("/api/checkout", {
  method: "POST",
  idempotencyKey: checkoutIntentKey,
  body: {
    plan_key: "starter",
    interval: "month",
    success_url: `${location.origin}/billing/success`,
    cancel_url: `${location.origin}/pricing`,
  },
});
location.assign(url);
```

Configure the billing service's CORS allowlist to the exact Lovable origin. The copied
file transports a short-lived user token; it does not verify identity, decode
entitlements, or make browser state authoritative. The Node/FastAPI service must verify
the token and map its immutable subject to `externalRef`.

`VITE_BILLING_API_URL` can be an HTTPS origin or an HTTPS mount prefix such as
`https://api.example/billing`; the copied transport preserves that prefix when it
appends a fixed `/api/...` route. Loopback HTTP remains available for local development.
Token size remains an identity-provider/server/proxy concern rather than an extra
browser-adapter policy; the final request still has to fit their documented header
limits.

If the host uses an HttpOnly session cookie, do not expose it to this adapter. Put a
same-origin BFF in the host application that verifies the session, applies CSRF checks,
strips caller-supplied identity headers, preserves the caller's idempotency key, and
forwards user-scoped identity evidence to the billing service. A shared service token
must not be allowed to choose an arbitrary billing owner.

On sign-out or subject change, cancel pending UI work, clear idempotent browser intents,
and remount billing state. No real Supabase/Clerk login E2E is currently recorded; see
[Adoption](ADOPTION.md#connect-authentication-and-tenant-authorization) for the complete
identity contract.

## v0 + Next.js

v0 is the closest fit for the native TypeScript path. The npm package is not published,
so import the whole public repository instead of asking v0 to install it. Keep both
`web/` and `typescript/`; `web/package.json` uses the checked-in
`file:../typescript` dependency.

Importing the repository does **not** select that backend by itself:
the default `vercel.json` intentionally routes billing to FastAPI. In a whole-repository
fork that retains the `web/` + `typescript/` layout, either deploy with
`-A vercel.typescript.json`, or deliberately copy `vercel.typescript.json` to that
fork's root `vercel.json`. Keep only one webhook processor active. In a standalone
root-level Next.js project, do **not** copy the monorepo Services file: use a pinned Git
checkout through a local `file:` dependency or install the local tarball, add the three
Route Handlers and output-file tracing, and use the small Cron-only configuration from
[Vercel](VERCEL.md#native-typescript-topology). Neither path needs a published npm
package; the [vendoring guide](ADOPTION.md#consume-a-pinned-git-source-or-vendored-copy)
lists the exact source, migrations, and catalog files.

For the `file:` path, add the vendored package's install/build commands to the host's
`prebuild` script as shown in that guide. This makes `npm run build` (including Vercel's
Build Command) create `dist/` before Next.js resolves the package exports; a local
developer build must not be the deployment's hidden prerequisite.

This short prompt is enough to start:

```text
Use https://github.com/ToseaAI/stripe-entitlements as the starting repository.
Build my product UI in web/ and keep its local typescript/ billing dependency. Preserve
the existing /api, /webhooks/stripe and /health Route Handlers. Use the native TypeScript
deployment: select vercel.typescript.json explicitly, or copy it to vercel.json only
while preserving this repository's web/ + typescript/ layout; do not leave the default
FastAPI routing active. Keep Stripe and database secrets server-side, connect my
authenticated user to the billing AuthAdapter, and show paid access only after GET
/api/account reflects the signed webhook.
```

Keep these five boundaries while changing the product:

- edit the visual pages/components, not the billing state machine;
- keep the three server Route Handlers on the Node runtime;
- never expose Stripe secret/webhook keys or the database URL to browser code;
- map the product's verified immutable user/team ID through `AuthAdapter`; and
- treat Checkout return as pending until `/api/account` shows webhook-projected access.

To change plans or entitlements, edit `plans.toml`, then run
`cd typescript && npm run sync:catalog`. Use `npm run sync:catalog -- --check` from that
directory as the no-write drift gate; do not make a native TypeScript/v0 project install
Python or maintain a second catalog by hand.

The current whole-source `file:` dependency and local tarball pass Next.js consumer
builds. That is not a hosted v0 journey, so test the generated deployment with isolated
Stripe test mode, PostgreSQL, and a real login before promoting it. Use the
[TypeScript guide](../typescript/README.md) when a separate repository needs the
registry-free Git-vendor or local-tarball path. Identity mapping and deployment details
are in [Adoption](ADOPTION.md) and [Vercel](VERCEL.md).

## Test the deployed staging site

Use only Stripe's documented test fixtures from the Dashboard documentation. At minimum,
verify:

1. a successful first Checkout remains Free until the signed webhook projects it;
2. a declined card leaves the source entitlement unchanged;
3. a 3DS/SCA card completes the hosted challenge and then waits for projection;
4. monthly and yearly Checkout use the expected Price and credit schedule;
5. each supported plan transition follows the selected transition policy;
6. Portal opens and returns to the exact staging origin;
7. one-time credit-pack purchase and refund converge to the expected source balance;
8. duplicate, delayed, and out-of-order webhook delivery stays idempotent;
9. Test Clock advancement produces the expected monthly grants and annual renewal; and
10. reconciliation repairs an intentionally missed test webhook.

The repository's real browser runner already covers Python and TypeScript with both plan
transition policies. For a deployed host, follow the remote-origin procedure in
[Browser E2E](BROWSER_E2E.md): use a private Playwright storage state for a real isolated
login and a read-only database verifier. A public simulation is never valid input to that
gate.

## What must wait for live mode

Keep these release gates explicitly `not run` until an approved live account exists:

- real card settlement, fees, refunds, disputes, and payouts;
- merchant activation/KYC and live payment-method availability;
- independently bootstrapped live Products, Prices, Portal configuration, and webhook
  secret; and
- one low-risk live Checkout plus a captured, signature-verified production payload.

Do not copy test object IDs or signing secrets into live configuration. Test and live
mode are separate inventories even when they appear in the same Stripe Dashboard.
