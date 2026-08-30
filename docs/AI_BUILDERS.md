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

| Mode | Stripe/PostgreSQL | What a visitor sees | Use it for |
| --- | --- | --- | --- |
| `simulation` | none | Browser-local plan, credit-pack, upgrade, and success-state simulation | Public GitHub demo, visual review, v0/Lovable layout work |
| test staging | real Stripe **test mode** plus isolated PostgreSQL | Real `checkout.stripe.com`, Portal, SCA/declines, and webhook-projected state | Controlled product acceptance and browser E2E |
| live production | real Stripe live mode plus production PostgreSQL | Real cards, money, refunds, and payouts | Approved production cutover only |

Never describe `simulation` as a Stripe E2E test. Never describe test staging as proof of
live settlement.

## Publish a UI-only simulation

The reference frontend has a production-safe simulation mode. It never sends a request
to Stripe or the billing backend. Its state lives only in the visitor's browser runtime,
and the page always displays a public-simulation warning.

Set the following public build variables in a frontend-only deployment:

```dotenv
NEXT_PUBLIC_BILLING_API_MODE=simulation
NEXT_PUBLIC_SIMULATION_ACKNOWLEDGEMENT=1
NEXT_PUBLIC_ALLOW_INDEXING=false
```

Production simulation builds fail when indexing is enabled, when the acknowledgement is
missing, or when a browser-visible demo Bearer token, Stripe publishable key,
`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `DATABASE_URL`, `DEMO_BEARER_TOKEN`, or
`CRON_SECRET` is present. Browser `sessionStorage` is required so a cross-page simulated
return cannot lose its pending state; denied storage fails closed with a visible error.

Use [`vercel.simulation.json`](../vercel.simulation.json) in a dedicated Vercel project.
It contains only the `web/` service and deliberately has no FastAPI service, API rewrite,
webhook rewrite, health rewrite, or Cron. Do **not** use the split [`vercel.json`](../vercel.json)
or the scheduled [`vercel.typescript.json`](../vercel.typescript.json) for this public
link. Do not set Stripe, webhook, database, authentication, or scheduler credentials in
the simulation project.

Keep the Vercel project Root Directory at the repository root and deploy the reviewed
alternative config explicitly:

```bash
npx vercel@59.10.0 -A vercel.simulation.json deploy
# after verifying the Preview URL
npx vercel@59.10.0 -A vercel.simulation.json deploy --prod
```

The repository has clean-install production-build and Chromium coverage for this
configuration, but no Vercel-hosted Preview deployment is recorded yet. Treat the two
commands as a deployment runbook until the resulting Preview URL passes the remote
simulation gate; do not cite the local tests as proof that Vercel accepted the project.

If an AI builder only recognizes `vercel.json`, copy `vercel.simulation.json` to that
name in a simulation-only downstream repository; do not overwrite the real-billing
configuration on the main release branch.

This is the appropriate mode for a public design link before a stable test backend and
identity provider exist. It simulates plan selection, an immediate plan change, a credit
pack, delayed projection, reload persistence, Portal return, and reset. It does not fake
Stripe's hosted pages, decline behavior, SCA, signed delivery, or money movement.
Run `cd web && npm run test:e2e:simulation` to build the exact production mode and prove
in Chromium that it remains `noindex`, renders the warning and billing interactions,
makes no `/api`, webhook, or Stripe request, and fails closed when browser storage is
denied. To test an already deployed link, set `SIMULATION_BASE_URL` to its HTTPS origin
and explicitly set `SIMULATION_ALLOW_REMOTE=1`.
The runner checks `X-Frontend-Build-Mode: production` and
`X-Billing-Api-Mode: simulation`, plus the disabled server routes, before clicking any
billing action; a normal staging/production site is rejected before mutation.

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

1. a managed PostgreSQL database containing migrations 001 and 002;
2. one Stripe test-mode catalog and safe test Portal configuration;
3. `sk_test_...` only on the server and `pk_test_...` only where Stripe.js needs it;
4. one test-mode Webhook Endpoint and its server-only `whsec_...`;
5. a real test identity provider, such as Supabase or Clerk;
6. a stable HTTPS origin for Checkout success/cancel, Portal return, CORS, and webhook
   delivery; and
7. a scheduler for annual grants and reconciliation.

Protect this site with an identity-provider allowlist, deployment access control, or
equivalent test-user gate, and keep it `noindex`. Test mode does not move money, but an
unrestricted site can still create Customers, Sessions, Subscriptions, Events, emails,
and operational noise in your Stripe test inventory.

Follow the complete [Vercel deployment runbook](VERCEL.md). Vercel is optional, but the
Node runtime and PostgreSQL transaction boundary are not. The checked-in five-minute
Cron schedule requires a Vercel plan that supports it; on Hobby, remove the Cron entries
and call the same protected routes from an external scheduler.

Do not share production resources with Preview deployments. If every preview cannot get
an isolated database, Stripe prefix, endpoint, and auth subject, use `simulation` for PR
previews and reserve the stable test staging site for payment tests.

## Lovable + Supabase

Lovable commonly owns a Vite UI and Supabase session. Keep this billing service on a
Node-capable or FastAPI host; do not move its `pg` transactions and raw-body webhook
handler into a Deno/Edge function without a separate port and race-safety review.

The checked-in `createSupabaseBrowserAuth` is a narrow browser transport adapter, not a
complete Supabase authentication starter. It obtains the current compact access token,
applies the same 8,192-byte bound as the HTTP client, and sanitizes provider errors. It
does not verify the token, authorize a tenant, handle account switching, or prove that
the token matches the repository's generic JWT contract.

The generic Python and TypeScript personal JWT starters require an asymmetric signature,
exact issuer/audience/algorithm, integer `exp` and `nbf`, and a canonical UUID `sub`.
Supabase documents `nbf` as optional, and its normal authenticated-token example does not
contain it. A default Supabase token can therefore receive 401 from this strict starter.
Do not configure the following environment merely by copying placeholders:

```dotenv
BILLING_AUTH_MODE=personal_jwt
BILLING_JWT_ISSUER=https://PROJECT_REF.supabase.co/auth/v1
BILLING_JWT_AUDIENCE=authenticated
BILLING_JWKS_URL=https://PROJECT_REF.supabase.co/auth/v1/.well-known/jwks.json
BILLING_JWT_ALGORITHMS=ES256
```

Copy the actual issuer, audience, JWKS URL, and signing algorithm from the Supabase
project. Then choose and test one server-side integration:

1. Prefer a same-origin, HttpOnly-cookie BFF that verifies the Supabase session with the
   provider's server SDK, applies CSRF protection, and returns a host-owned
   `AuthAccountAdapter` identity.
2. Implement a provider-specific server adapter that verifies the Supabase token and
   maps its immutable user ID to `externalRef`.
3. Use the generic JWKS starter only after an integration test proves that issued tokens
   contain every required claim. A custom access-token hook may add `nbf`, but its exact
   integer value, signature, issuer, audience, algorithm, and UUID subject must still be
   verified; the hook itself is not evidence.

Email is display metadata, never ownership authority. Supabase JavaScript clients also
persist sessions in `localStorage` by default. Decide whether that XSS exposure is
acceptable for the host threat model; the HttpOnly BFF avoids exposing the access token
to this reference client but requires deliberate cookie/CSRF integration.

The reference frontend includes a dependency-free adapter for a Supabase browser client:

```typescript
import { createHttpBillingApi } from "@/lib/http-api";
import { createSupabaseBrowserAuth } from "@/lib/supabase-auth";
import { supabase } from "@/lib/supabase";

export const billingApi = createHttpBillingApi({
  baseUrl: "https://billing-staging.example.com",
  auth: createSupabaseBrowserAuth(supabase),
});
```

`@/lib/supabase` is intentionally host-provided; this repository does not create or
configure a Supabase client. For a same-origin Next.js deployment, use
`baseUrl: "same-origin"`.

When the verified auth subject changes or signs out, cancel outstanding UI work, unmount
the billing screens, call `clearAllIdempotentIntents()` from `web/lib/idempotency.ts`,
and mount a fresh API/UI instance. The browser keys are intentionally reusable for one
user intent and are not namespaced by an untrusted browser subject. The server remains
account-scoped, but stale UI state must not be shown after an account switch.

No real Supabase login/JWKS browser E2E is currently recorded for this repository. Clerk
also does not automatically fit the generic starter: its normal `sub` is not necessarily
a canonical UUID. Use a provider-specific server adapter or a tested immutable mapping
rather than weakening subject validation globally.

## v0 + Next.js

v0 is the closest fit for the native TypeScript path. Import this monorepo and preserve
these server-owned files when replacing the visual layer:

- `web/app/api/[...billing]/route.ts`;
- `web/app/webhooks/stripe/route.ts`;
- `web/app/health/route.ts`;
- the Node runtime declaration and raw-body webhook behavior; and
- the billing package, migrations, catalog, and environment contract.

Give the builder this constraint block:

```text
Replace only the visual product pages and components. Keep every billing Route Handler,
the Node runtime, raw Stripe webhook bytes, server environment variables, PostgreSQL
transactions, AuthAdapter, idempotency headers, and webhook-backed success polling.
Never create Checkout or trust plan/account/credit state in a Client Component. Never
expose sk_test, sk_live, whsec, database URLs, client secrets, recovery URLs, or a shared
Bearer token. A Checkout return is not entitlement proof.
```

This is currently a source-repository workflow, not a verified one-click builder import
or a new-project `npm install` quick start: `@tosea/stripe-entitlements` is not yet
published to the public npm registry, `web/package.json` uses the local
`../typescript` package, and no v0 platform-import E2E is recorded. Publish a matching
npm release, install a pinned GitHub Release tarball, or vendor the reviewed package
before asking a fresh v0 project to import it.

Lovable's default Vite runtime likewise cannot execute the Next.js Route Handlers, and
this repository does not yet contain a runnable Lovable/Vite simulation starter. Use
Lovable only to produce the visual layer, then deliberately port the browser-local
simulation adapter for a non-payment demo or call a separately deployed Node/FastAPI
service for real test billing. Do not describe either path as one-click until that exact
generated project has its own build and browser E2E evidence.

If the generated app uses an HttpOnly session rather than a browser JWT, add a same-origin
BFF with CSRF protection and verified user context. One generic service token must never
let a browser choose an arbitrary billing owner.

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
