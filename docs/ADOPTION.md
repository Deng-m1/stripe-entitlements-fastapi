# Adopting the reference in an existing application

This guide explains how to connect the repository to an existing user system,
organization model, product jobs, and frontend. It distinguishes code this repository
already implements from policy and coordination that the host application must own.

The current working tree supports two independent backend implementations. Python can
run as a standalone FastAPI billing application or install into an existing FastAPI
root. TypeScript can run as a standalone Node service, a Fetch-compatible handler, or
native Next.js App Router Route Handlers. Both include production-oriented personal/team
JWT authentication starters, an in-process `EntitlementService`, and an optional
owner-bound internal workload boundary. Neither is a complete product/Job framework.

This guide assumes an exact release-tag source checkout or a matching Python/npm
artifact. Until a matching tag and published artifact exist, pin the exact
reviewed commit rather than assuming that the latest older tag or a package index
contains this code. The Wheel contains the Python backend runtime, migrations, and
catalog; the npm tarball contains the TypeScript runtime, declarations, CLI, migrations,
and catalog. The source distribution additionally contains `.env` templates,
operator scripts, Docker/Compose files, auth and Job examples, tests, and the Next.js
reference UI needed by the end-to-end commands in this guide.

For a published version tag, the repository release workflow attaches both Python
distributions, the verified TypeScript npm tarball, and their checksums to the GitHub
Release and records the immutable GHCR container digest. That is distinct from PyPI or
npm-registry publication; do not install an unrelated or older package-index artifact
merely because its name matches.
The published GHCR image is currently native `linux/amd64`; it is not a verified
multi-architecture manifest. ARM64 adopters should use the Wheel/source distribution or
build and validate the pinned Dockerfile on their target platform.

## Contents

- [Responsibility and deployment choices](#responsibility-boundary)
- [Runtime and host-system dependencies](#runtime-dependencies)
- [Users, tenants and other host entities](#define-the-billable-owner-first)
- [Authentication, authorization and FastAPI composition](#connect-authentication-and-tenant-authorization)
- [Node and Next.js composition](#compose-a-typescript-application)
- [Entitlement enforcement](#enforce-product-entitlements-on-the-server)
- [Credits and durable Job coordination](#associate-credits-with-product-jobs)
- [Standalone-service private APIs](#standalone-service-private-apis)
- [Next.js or replacement frontend](#connect-or-replace-the-nextjs-frontend)
- [Catalog customization](#customize-the-catalog-deliberately)
- [Real test-mode setup](#complete-the-real-test-mode-setup)
- [Schedulers and production cutover](#schedule-workers-and-operate-the-dependency-chain)
- [Host contract tests](#host-integration-contract-tests)

## Responsibility boundary

| Capability                                                     | Repository                                                | Host application                                                     |
| -------------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------- |
| Stripe Checkout, Portal, plan changes and signed webhooks      | Implemented                                               | Configure and operate                                                |
| Duplicate, delayed, concurrent and out-of-order Event handling | Implemented                                               | Preserve the database invariants                                     |
| Billing account resolution from one stable subject             | Implemented                                               | Choose and verify that subject                                       |
| Session, JWT or OIDC verification                              | Strict JWT/JWKS starter plus adapter protocol             | Configure the starter or implement another verifier                  |
| Tenant membership and billing-admin authorization              | Team starter and explicit route policy                    | Supply the live membership repository and lifecycle                  |
| Catalog, account and billing mutation HTTP APIs                | Implemented                                               | Authenticate and consume                                             |
| FastAPI router or TypeScript Fetch/Node/Next facade            | Implemented in each runtime                               | Choose one runtime and preserve its lifecycle tests                  |
| Entitlement check and atomic credit charge/refund              | Implemented in-process and as an optional internal router | Bind each workload to the requested owner                            |
| Job creation plus credit charge as one business workflow       | Runnable reference schema/workflow/demo                   | Adapt it to host Job/queue tables and operate the outbox/repair loop |
| Feature and numeric-limit enforcement                          | Returned as data                                          | Enforce in the product backend                                       |
| Concurrent-job and API-key limits                              | Returned as data                                          | Enforce transactionally in host tables                               |
| Production frontend authentication                             | Browser adapter plus server JWT/session boundaries        | Configure an identity provider or add a BFF                          |
| Annual grants and reconciliation                               | Commands implemented                                      | Schedule and monitor                                                 |
| Identity merge, transfer, deletion and plan grandfathering     | Not implemented                                           | Define and implement                                                 |

## Choose an adoption shape

| Shape                             | Current fit            | Use when                                                | Important limitation                                                                        |
| --------------------------------- | ---------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Fork the complete repository      | Best supported         | Building a new FastAPI billing boundary                 | You own future upstream merges                                                              |
| Vercel Services full stack        | Supported              | New Next.js + FastAPI SaaS on one domain                | Still needs managed PostgreSQL, Stripe, and real identity integration                       |
| Native TypeScript/Next.js backend | Supported              | A Node-only or full-stack Next.js SaaS                  | Requires Node runtime Route Handlers and managed PostgreSQL; Edge is unsupported            |
| Standalone Node billing service   | Supported              | The product is TypeScript or uses a Fetch/HTTP boundary | Product Job/queue coordination remains host-owned                                           |
| Standalone billing service        | Supported              | The host is large, separately deployed or not Python    | Configure both workload authentication and owner authorization before enabling private APIs |
| Same-process FastAPI composition  | Supported              | The host is Python and already owns a FastAPI root      | Install before startup and test route-prefix conflicts                                      |
| Python service facade             | Supported              | Product code runs in the billing process                | Services exist only inside the installed lifespan                                           |
| Other-language client SDK         | Not currently supplied | —                                                       | Use the authenticated internal HTTP boundary or build a typed client                        |

For an existing FastAPI application, `install_billing` is the supported same-process
path. It installs a native `APIRouter`, scopes browser CORS/Origin handling to public
billing routes and response hardening to installed billing routes, keeps unrelated host
routes unchanged, and composes the existing host lifespan with the billing lifespan. A
separately deployed billing service remains a good boundary for non-Python or
independently operated hosts.

For a new web product that does not need a separate Railway/API deployment, the
checked-in Vercel Services configuration deploys Next.js and this same FastAPI package
behind one domain and supplies secured bounded Cron routes. It does not fork or rewrite
the billing state machine. Follow [the Vercel guide](VERCEL.md); PostgreSQL and host
identity remain explicit dependencies.

The alternative [`vercel.typescript.json`](../vercel.typescript.json) keeps the same UI,
public paths, database contract, and Cron cadence but implements the backend in native
Next.js Node Route Handlers. It has no Python runtime dependency. Follow the
[TypeScript package guide](../typescript/README.md); do not deploy these handlers on the
Edge runtime.

For a standalone service, the browser-facing billing APIs are usable after injecting
real authentication. The optional internal router exposes owner-bound check, charge,
and refund operations to authenticated workloads; it is reject-all until the host
supplies both a workload identity adapter and an owner authorizer. Never expose that
router or `CreditService` directly to a browser.

The documented Python integration surface is intentionally small:

- package-root `BillingKernel`, `BillingServices`, `create_app`,
  `create_billing_router`, and `install_billing`;
- `Settings` and `Database` when the host injects configuration or owns the pool;
- `AuthAccountAdapter` plus the personal/team classes in `auth_starters`;
- `kernel.services.entitlements` for owner-bound checks and credit operations; and
- `create_internal_router` plus the workload identity/owner-authorization protocols for
  a separate service boundary.

The Wheel carries a PEP 561 `py.typed` marker so downstream type checkers can validate
these calls. Product code does not need to query `credit_pack_orders`, funding lots,
debit allocations, or pack clawback debts. Migrations own their schema and the public
router/`EntitlementService`/reconciler own their behavior. Direct imports of processor,
pack-accounting, or SQL helpers are reference-internal coupling unless this guide names
the exact class as an integration boundary.

The equivalent TypeScript integration surface is:

- package-root `BillingKernel`, `createBillingRuntime`, and
  `createBillingFetchHandler`;
- `@tosea/stripe-entitlements/node` for the standalone server/CLI adapter;
- `@tosea/stripe-entitlements/next` for App Router Route Handlers;
- `AuthAccountAdapter` plus personal/team JWT starter classes;
- `runtime.kernel.requireServices().entitlements` for same-process product checks and
  exact credit operations; and
- `createInternalBillingFetchHandler` for an owner-authorized service boundary.

The npm artifact includes `.d.ts` declarations and packaged canonical resources. Product
code should use those facades rather than importing projector/accounting internals.

## Runtime dependencies

The repository does not require the host to use a particular user ORM, job queue, or
identity provider. Its hard runtime assumptions are narrower but significant:

- either Python 3.12+/FastAPI or Node.js 22+/TypeScript for the billing API;
- PostgreSQL as both durable state and the distributed coordination layer;
- `asyncpg` (Python) or `pg` (TypeScript) and the same unqualified SQL schema;
- one Stripe account/mode, one product line, one recurring Subscription item and USD;
- a public signed Stripe webhook endpoint;
- a scheduler for annual grants and reconciliation (including the checked-in Vercel
  Cron option); and
- Node.js 22+ and npm when using the TypeScript backend or Next.js reference UI.

Redis, Celery and a particular JWT library are not required. If the host uses SQLAlchemy,
Django ORM, another database, or another language, run billing as a separate service
rather than letting application code write its tables.

Production should use a dedicated billing database. The migration creates
`schema_migrations`, fourteen correctness tables, and their coordination functions and
triggers in the current PostgreSQL `search_path`; there is no `BILLING_DB_SCHEMA`
namespace setting. The
fourteen tables must be backed up and restored as one unit.

Initialize that database before traffic:

```bash
uv run --env-file .env stripe-entitlements migrate
```

The 0.3 schema is a fresh-install baseline. A database initialized from the v0.2.x
lineage cannot be upgraded in place: preserve required evidence and create a new
development, demo or staging database. Never edit `schema_migrations` to bypass the
lineage/checksum guard. Once a baseline is published, keep it immutable and append
`002_...sql` and later migrations. An existing application's own unqualified
`schema_migrations` table is another reason to choose a dedicated billing database.

### Host-system compatibility

| Existing host                                    | Integration effort      | Reason                                                                                                                                |
| ------------------------------------------------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| FastAPI plus verified Bearer JWT/OIDC            | Low to moderate         | Personal/team JWT starters are supplied; issuer settings and team membership remain host-owned                                        |
| FastAPI plus server session/HttpOnly cookie      | Moderate in one process | The backend adapter can read the cookie; the reference browser client needs a BFF or transport change                                 |
| SQLAlchemy or Django application                 | Moderate as a sidecar   | Billing uses fixed `asyncpg` SQL and does not expose ORM models                                                                       |
| Node/Next.js with verified JWT or server session | Low to moderate         | Native TypeScript runtime and Fetch/Route Handler adapters are supplied                                                               |
| Other non-Python service                         | Moderate to high        | Public billing plus the optional workload-authenticated internal boundary are HTTP-accessible; the host still needs a client and saga |
| User-only SaaS                                   | Lower                   | One immutable user subject maps directly to one billing account                                                                       |
| Multi-tenant/team SaaS                           | Higher                  | Membership, selected-tenant validation, billing roles and tenant lifecycle remain host concerns                                       |
| Existing job queue/workflow engine               | Moderate to high        | The queue is unrestricted, but charge/job atomicity needs a durable saga/outbox                                                       |

An identity proxy may supply a subject header only when the billing service is unreachable
from the public network, the proxy strips every inbound copy of that header, and the hop
is authenticated. Treating an arbitrary reverse-proxy header as identity is not supported.

## Define the billable owner first

Do not assume that a signed-in user is the subscription owner. Decide once whether one
subscription belongs to an individual user or to an organization/workspace.

```python
# host/billing_owner.py
from dataclasses import dataclass
from typing import Literal
from uuid import UUID

OwnerKind = Literal["user", "tenant"]


@dataclass(frozen=True, slots=True)
class BillingOwner:
    kind: OwnerKind
    id: UUID

    @property
    def external_ref(self) -> str:
        return f"v1:{self.kind}:{self.id}"
```

Recommended mappings:

| Product model                                        | Stable billing subject              |
| ---------------------------------------------------- | ----------------------------------- |
| One subscription per person                          | `v1:user:<immutable-user-uuid>`     |
| One subscription shared by organization members      | `v1:tenant:<immutable-tenant-uuid>` |
| A user in several independently billed organizations | One tenant subject per organization |

`external_ref` is globally unique in `billing_accounts`, contains 1–512 visible UTF-8
bytes, and resolves to one internal billing account. That account owns at most one Stripe
Customer and one Subscription in the implemented model.

The shared validator deliberately rejects a bare UUID and values beginning with Stripe
account selectors such as `cus_`, `sub_`, or `acct_`. Namespace host IDs as shown above;
the public auth adapter, database resolver, service facade, and internal workload API all
enforce the same rule before creating or selecting an account.

Rules for a durable subject:

- include a version and entity namespace;
- use a non-recycled immutable host ID;
- derive the tenant only after server-side membership verification;
- never use email, username, display name or mutable tenant slug;
- never accept a browser-supplied billing account ID as ownership proof; and
- never silently change an encoding after it has reached Stripe or PostgreSQL.

Email is an optional Checkout hint, not identity. `billing_accounts.id` is an internal
UUID. The browser does not need it and must not select it.

The current schema has no identity merge, subject rename, organization transfer or
account-deletion workflow. If the host can merge users, transfer tenants, reuse IDs, or
delete application rows while retaining financial audit, define an operator-reviewed
migration procedure before launch. Do not repair identity by editing Stripe metadata or
accepting a different account ID from the client.

Do not directly delete `billing_accounts`. Foreign keys can restrict an incomplete
delete, while other relationships intentionally cascade; a direct delete can destroy
ledger/intent identity and leave late webhooks without an owner. Retain an immutable
tombstone/mapping and the complete billing audit until a reviewed migration workflow
defines personal-to-tenant or tenant-to-tenant transfer semantics.

### Host entity dependency map

| Host entity                    | Required coupling to billing                                          |
| ------------------------------ | --------------------------------------------------------------------- |
| User                           | One immutable ID only for personal billing; no billing FK is required |
| Tenant/organization            | One immutable ID for team billing; membership stays in the host       |
| Membership/role                | Verified on every relevant request; no role is stored by billing      |
| Job/conversion/AI call         | Immutable attempt key plus host outbox state; no built-in Job FK      |
| Uploaded file or request input | Host validates catalog feature and numeric limits                     |
| API key                        | Host stores/counts keys transactionally against the catalog limit     |
| Queue worker                   | Host owns execution leases, fencing and idempotent delivery           |
| Stripe Customer/Subscription   | Billing-owned; host must not use either as user identity              |

An optional host table can map `(owner_kind, owner_id)` to `external_ref` for lifecycle
and audit, but a deterministic encoding often makes it unnecessary. Do not add a foreign
key from the host database to billing tables when the services have independent backup,
deployment or availability boundaries.

## Connect authentication and tenant authorization

[`AuthAccountAdapter`](../src/stripe_entitlements/auth.py) is the production identity
boundary. The adapter receives a FastAPI `Request` and returns a verified
`AuthenticatedIdentity`. The safe default rejects every protected request.

Install the optional asymmetric JWT/JWKS verifier:

```bash
uv sync --extra auth
```

The personal starter verifies signature, algorithm, `iss`, exact `aud`, `exp`, `nbf`,
canonical UUID `sub`, and `kid`, then maps that immutable subject to
`v1:user:<sub>`. Only an exactly true signed `email_verified` claim permits forwarding
the email as a Checkout hint:

```python
from stripe_entitlements.auth_starters import (
    JwtVerificationConfig,
    JwtVerifier,
    PersonalJwtAuthAdapter,
)

verifier = JwtVerifier(
    JwtVerificationConfig(
        issuer="https://identity.example.com/",
        audience="billing-api",
        jwks_url="https://identity.example.com/.well-known/jwks.json",
        algorithms=("RS256",),
    )
)
personal_auth = PersonalJwtAuthAdapter(verifier)
```

For a team-owned subscription, supply a live `TeamMembershipRepository`. The signed
`tenant_id` UUID remains only a selector: `TeamJwtAuthAdapter` queries membership for
the verified `(sub, tenant_id)` pair on every request. Its explicit policy permits a
viewer to read only catalog routes; `/api/account`, recovery URLs, Checkout, Portal,
plan changes, and unknown billing routes require `billing_admin`:

```python
from stripe_entitlements.auth_starters import (
    TeamBillingAuthorizationPolicy,
    TeamJwtAuthAdapter,
)

# memberships implements membership_for(user_id, tenant_id).
team_auth = TeamJwtAuthAdapter(
    verifier,
    memberships,
    authorization=TeamBillingAuthorizationPolicy(billing_prefix="/stripe"),
)
```

The authorization prefix is explicit; the policy does not guess it. Pass the same
prefix to `install_billing`. For standalone `create_app()` routes, use the default
`TeamBillingAuthorizationPolicy()` and no billing prefix.

Complete executable personal and team entrypoints, including the example PostgreSQL
membership table, live in
[`examples/auth_starters/`](../examples/auth_starters/README.md). Start them with:

```bash
uv run --env-file .env uvicorn \
  examples.auth_starters.personal_app:create_host_app \
  --factory --host 0.0.0.0 --port 8000

uv run --env-file .env uvicorn \
  examples.auth_starters.team_app:create_host_app \
  --factory --host 0.0.0.0 --port 8000
```

The token verifier handles known invalid/expired credentials as sanitized 401s and a
known JWKS transport failure as a sanitized 503. A decoded but unverified JWT is never
authentication. Hosts still own token revocation/session policy and the team membership
lifecycle. Implement another `AuthAccountAdapter` when the product uses cookie sessions
or a different identity protocol.

A selected-tenant claim, route parameter, cookie or header is only a selector. A bare
`X-Tenant-ID`, `X-User-ID`, query parameter, request body field or email must never
become `external_ref` directly.

Pass an email to Stripe only when the host identity provider has verified it. Otherwise
return `email=None`; email remains an optional Checkout hint.

`GET /api/account` can contain a Stripe hosted-invoice recovery URL, which is a payment
capability. The supplied team policy therefore keeps viewers on catalog-only data and
requires a billing administrator for the full account view and every mutation. Extend
its explicit route-to-capability map and tests when adding routes; never authorize a
viewer by HTTP method alone.

## Compose a TypeScript application

The native package does not call the Python service. Initialize its canonical schema,
then run the standalone Node server:

```bash
cd typescript
npm ci
cp .env.example .env
chmod 600 .env
set -a
. ./.env
set +a
npx stripe-entitlements migrate
npx stripe-entitlements doctor
npx stripe-entitlements serve
```

Production defaults to reject-all authentication. `BILLING_AUTH_MODE=personal_jwt` plus
the complete issuer/audience/JWKS configuration enables the strict personal-user
starter. For a host session or team model, inject an adapter and own the returned
runtime lifecycle:

```typescript
import {
  createBillingRuntime,
  type AuthAccountAdapter,
} from "@tosea/stripe-entitlements";

const auth: AuthAccountAdapter = {
  async authenticate(request) {
    const session = await verifyYourServerSession(request);
    return { externalRef: `v1:user:${session.immutableUserId}` };
  },
};

const runtime = await createBillingRuntime({ auth });
export const billingHandler = runtime.handler;

export async function shutdownBilling() {
  // Register this with the host's process/application shutdown hook.
  await runtime.close();
}
```

The `runtime.handler` value uses the standard Fetch `Request → Response` contract, so a
host can adapt it without reimplementing signature verification, origin checks, route
contracts, or error sanitization. One runtime owns one connected kernel. Do not create a
new runtime per request.

For Next.js App Router, the environment-backed adapter lazily shares one runtime across
warm Node invocations:

```typescript
// app/api/[...billing]/route.ts
import { environmentNextBillingRouteHandler as handle } from "@tosea/stripe-entitlements/next";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const GET = handle;
export const POST = handle;
export const OPTIONS = handle;
```

Create separate explicit Route Handler files for `/webhooks/stripe` and `/health` as
shown under [`web/app/`](../web/app/). Stripe and `pg` require the Node runtime; Edge is
unsupported. The source checkout uses `file:../typescript`, while a downstream project
should install the exact reviewed npm artifact when one is published.

Same-process product code reaches
`runtime.kernel.requireServices().entitlements`. A separately deployed product uses
`createInternalBillingFetchHandler` with both a verified workload identity and an exact
workload-to-owner authorizer. In either form, host Job state, queue dispatch, concurrency
limits, API-key tables, and the Job/credit outbox-saga remain host-owned.

Complete standalone, Next.js, authentication, worker, and test commands are in the
[TypeScript package guide](../typescript/README.md).

## Compose the FastAPI application

### Standalone billing application

For a dedicated billing process or a new root application, `create_app` remains the
smallest entrypoint. Use a host-owned factory so production never starts with the
default `RejectAllAuthAdapter`:

```python
# host_billing.py
from stripe_entitlements import create_app
from stripe_entitlements.auth_starters import (
    JwtVerificationConfig,
    JwtVerifier,
    PersonalJwtAuthAdapter,
)
from stripe_entitlements.config import get_settings


def create_host_app():
    verifier = JwtVerifier(
        JwtVerificationConfig(
            issuer="https://identity.example.com/",
            audience="billing-api",
            jwks_url="https://identity.example.com/.well-known/jwks.json",
            algorithms=("RS256",),
        )
    )
    return create_app(
        get_settings(),
        auth_adapter=PersonalJwtAuthAdapter(verifier),
    )
```

```bash
uvicorn host_billing:create_host_app --factory --host 0.0.0.0 --port 8000
```

`create_app` accepts `settings`, `database`, `gateway`, and `auth_adapter`. If the
injected `Database` is not connected, the app lifespan connects and closes it. If it is
already connected, its owner remains responsible for closing it.

The stock Docker command is intentionally safe but incomplete for production identity:
without an injected adapter, protected APIs return 401. Do not enable the demo Bearer
adapter in production.

### Install into an existing FastAPI root

Use `BillingKernel` plus `install_billing` instead of copying route objects or mounting
the standalone app. This minimal host owns the injected pool in its existing lifespan:

```python
# host_app.py
from contextlib import asynccontextmanager

from fastapi import FastAPI

from stripe_entitlements import BillingKernel, install_billing
from stripe_entitlements.config import get_settings
from stripe_entitlements.database import Database

from host.auth import personal_auth

settings = get_settings()
database = Database(settings.database_url)


@asynccontextmanager
async def lifespan(app: FastAPI):
    del app
    await database.connect()
    try:
        yield
    finally:
        await database.close()


app = FastAPI(lifespan=lifespan)
kernel = BillingKernel(
    settings,
    database=database,
    auth_adapter=personal_auth,
)
install_billing(app, kernel, prefix="/stripe")
```

```bash
uvicorn host_app:app --host 0.0.0.0 --port 8000
```

Installation must happen before application startup. The composed lifespan enters the
existing host lifespan first and the billing lifespan second, then unwinds in reverse.
That ordering lets billing reuse a pool connected by the host without closing it. If the
kernel receives an unconnected `Database`, it connects and closes that pool itself.
One `Database` object may bind to exactly one `BillingKernel`; constructing a second
kernel with the same object fails immediately. Reuse one kernel within its application,
or construct separate `Database` objects from the same DSN for separately owned apps.

The installer includes a native prefixed `APIRouter` in the host OpenAPI document.
Browser CORS and untrusted-Origin rejection apply only to public billing routes;
no-store hardening covers both public billing routes and explicitly installed internal
routes. Unrelated host routes and global logging configuration are unchanged. The
installed kernel is available as `app.state.stripe_entitlements`, while
`kernel.services` is intentionally valid only inside the active lifespan.

Before using same-process composition, explicitly test:

- both applications' lifespan/startup/shutdown behavior;
- middleware order, exception handlers, tracing, metrics and security headers;
- app state and database-pool ownership;
- CORS and trusted origins on both billing and unrelated host routes;
- OpenAPI metadata and route-prefix conflicts; and
- readiness semantics and graceful shutdown.

Do not call `create_app()`, extract its route list, and attach it to another app;
`include_router` alone cannot transfer a child app's lifespan, middleware, or state.
`install_billing` is the supported composition boundary.

## Resolve host entities to billing accounts

The database facade provides three useful operations:

- `account_for_external_ref(ref)` resolves or concurrently creates an account;
- `existing_account_for_external_ref(ref)` resolves without creating one; and
- `create_account(ref, account_id=...)` explicitly provisions an account.

Billing account and Checkout routes can create a Free account for an authenticated
subject. Product work should normally use `existing_account_for_external_ref` so an
unauthorized or unpaid job does not create empty billing rows.

Do not copy Stripe Customer or Subscription IDs into host user tables as the ownership
authority. An optional host mapping row may cache `external_ref` or the internal billing
UUID for observability, but every request still needs authenticated owner resolution.
`GET /api/account` currently returns that opaque UUID, but no protected route accepts it
as the account selector. Treat it as diagnostic data, never authorization.

## Enforce product entitlements on the server

`GET /api/account` returns the webhook-projected plan, credit balance, structured
entitlements, pending state and `entitlements_enforceable`. It does not enforce product
operations by itself, and its pending state may include a hosted payment-recovery URL.
Treat it as a billing-administrator response, not a generic team-member entitlement
document. Expose a separate sanitized host endpoint for ordinary product users.

Credit quantities use the exact wire contract documented in
[Exact fractional product credits](CREDIT_PRECISION.md): decimal strings plus atom
strings and a fixed scale. Do not parse the balance into a JavaScript `number` or a
Python `float` before enforcing it.

Separate subscription entitlement admission from credit funding admission:

1. Every request must resolve authenticated identity and membership to the expected
   billable owner.
2. A Job that requires a paid-plan feature or limit must require
   `EntitlementService.check(...).allowed`; that decision includes an enforceable
   subscription plus every requested feature and numeric limit.
3. A credit-only Job may use `credits_spendable` as a current display/admission hint, but
   the atomic `charge` result is the authority. Another worker can spend the balance
   immediately after a check.
4. A Job that requires both plan access and credits must pass the feature/limit decision
   and commit its credit charge before expensive work starts.

By default an active, unexpired credit-pack lot remains spendable after a subscription
ends; it does not make subscription features or limits enforceable. Requiring an active
subscription for pack purchase or pack-funded work is an optional host policy and must
be added explicitly at those admission boundaries. Do not implement it by deleting pack
funding or by treating `entitlements_enforceable` as the definition of credit spendability.

Never authorize from a browser redirect, Checkout Session URL, `confirm` response,
mutable Stripe Subscription read, or cached client-side account JSON.

Static limits require host behavior:

| Entitlement                         | Enforcement point                                        |
| ----------------------------------- | -------------------------------------------------------- |
| Feature flag such as `api_access`   | API authorization before work starts                     |
| `max_file_mb` / `max_pages_per_job` | Request validation before upload/queue admission         |
| `concurrent_jobs`                   | Transactional host job lease/count                       |
| `api_keys`                          | Transactional host API-key table constraint              |
| Subscription and pack credits       | owner-bound `EntitlementService.charge` before execution |

In-process product routes can use the initialized `EntitlementService` facade without
reading billing tables or accepting an internal billing UUID:

```python
from fastapi import APIRouter, HTTPException, Request

router = APIRouter()


@router.post("/convert")
async def convert(request: Request):
    kernel = request.app.state.stripe_entitlements
    decision = await kernel.services.entitlements.check(
        request.state.billing_owner_external_ref,
        required_features=("pdf_to_ppt",),
        required_limits={"max_pages_per_job": 80},
    )
    if not decision.allowed:
        raise HTTPException(403, decision.reason)
    return {"accepted": True}
```

The owner reference in this example must already come from verified personal/team
identity and membership, not the request body. `EntitlementService.check` returns a
fail-closed `owner_not_found` decision for an unknown owner; its owner-bound `charge`
and `refund` methods preserve exact decimal amounts, idempotency, and credit-epoch
semantics. `credits_spendable` and `credit_balance` describe only currently usable
subscription/pack funding, and `credit_expires_at` is the earliest expiry among those
usable sources. They remain snapshots; only `charge` serializes concurrent consumption.
The service deliberately does not enforce host Job counts, API-key rows, or upload limits
by itself.

Positive caching is a host security/product decision because it can extend access for
its TTL after revocation. Fail closed when a cached value expires or cannot be refreshed.

Feature and limit checks also have a time-of-check/time-of-use boundary. Decide whether
the entitlement is fixed when a charged Job becomes ready or must be checked again when
an execution lease starts. For expensive or long-delayed work, recheck before execution
and define whether a post-charge revocation cancels and refunds, pauses, or permits the
already-admitted attempt. Test that decision against queue, cancellation and refund
races.

## Associate credits with product jobs

[`CreditService`](../src/stripe_entitlements/credits.py) provides database-atomic,
concurrency-safe primitives:

```text
charge(account_id, amount, idempotency_key)
refund(idempotency_key)
```

The lower-level module remains importable for existing integrations. New in-process
code should normally enter through `kernel.services.entitlements`, which resolves stable
owners before delegating to the same credit primitive. Until a matching 0.3 artifact is
published, pin the reviewed source commit and retain host contract tests.

The debit key is global across `credit_debits`. It must identify one immutable business
attempt and cannot later be reused with another account or amount.

```python
from decimal import Decimal
from uuid import UUID

from stripe_entitlements.credit_amount import CreditAmount
from stripe_entitlements.credits import CreditService, CreditsUnavailableError
from stripe_entitlements.database import Database


class JobCredits:
    def __init__(self, database: Database) -> None:
        self.database = database

    @staticmethod
    def key(job_id: UUID, billing_attempt_id: UUID) -> str:
        return f"job:v1:{job_id}:attempt:{billing_attempt_id}"

    async def account_id(self, owner: BillingOwner) -> str:
        row = await self.database.existing_account_for_external_ref(owner.external_ref)
        if row is None:
            raise CreditsUnavailableError("billing account does not exist")
        return str(row["id"])

    async def charge(
        self,
        owner: BillingOwner,
        amount: CreditAmount | Decimal | int | str,
        job_id: UUID,
        billing_attempt_id: UUID,
    ):
        key = self.key(job_id, billing_attempt_id)
        account_id = await self.account_id(owner)
        result = await CreditService(self.database.require_pool()).charge(account_id, amount, key)
        return key, result

    async def refund(self, key: str):
        return await CreditService(self.database.require_pool()).refund(key)
```

An integer amount retains the historical meaning of whole credits. Use a decimal string,
`Decimal`, or `CreditAmount` for fractions; binary `float` is rejected. Store the
canonical decimal or atom string in a host outbox so another language cannot reinterpret
the request before an idempotent replay. `CreditResult.balance`, `requested`, and
`restored` are `CreditAmount` values, with their exact forms available through
`balance_atoms`, `requested_atoms`, and `restored_atoms`. The internal HTTP response
serializes each decimal and atom value as a string plus `scale=1000000`.

Result and error semantics matter:

- `charged` / `refunded`: this call committed the effect;
- `replayed` from `charge`: a matching debit row exists, but it may already have been
  refunded; it is not proof that the Job may start;
- `replayed` from `refund`: that debit was already refunded; the returned balance is
  current, not a historical transaction balance, while `requested` and `restored` are
  the original persisted operation values;
- `epoch_expired`: a refund arrived after the funding epoch closed and cannot recreate
  old credits;
- `InsufficientCreditsError`: do not start the job;
- `CreditsUnavailableError`: no subscription or pack funding source is currently usable;
- `ValueError`: the key or parameters conflict and require investigation; and
- `KeyError` from refund: no matching debit exists and the workflow is out of order.

Refund must reuse the original charge key. Synthetic pack-debt collection keys are not
product operations and cannot be charged or refunded through this facade. If a refunded
job is attempted again, create
a new immutable billing-attempt ID and therefore a new debit key. A same-epoch refund
may also be consumed by outstanding clawback debt, so callers must use the returned
balance rather than assuming that the pre-charge balance was restored.

The host attempt state is the authority for whether a charge replay may advance a Job.
Only an attempt that is still monotonically `pending_credit`/`charging`, has not entered
refund or terminal failure, and is finalized by the current lease token may become
ready. A stale charge replay after refund must never revive the Job.

## Coordinate job creation and credit charging

`CreditService` opens its own PostgreSQL connection and transaction. It does not accept
a host connection or unit of work. Consequently, inserting a host Job, charging credit,
and publishing to a queue are not one atomic transaction—even when both schemas use the
same PostgreSQL server.

Do not implement a production job endpoint as “charge, then best-effort insert and
publish.” A crash after the charge can leave an orphan debit. Use a durable saga/outbox:

```text
host transaction
  create Job(state=pending_credit)
  create billing outbox(charge, owner_ref, amount, immutable credit_key)
        │
        ▼
outbox worker claims with a lease
  commit the lease before calling billing
  resolve existing billing account
  CreditService.charge(..., same credit_key)
        │
        ├─ charged/replayed ─► fenced host transaction: Job=ready,
        │                      billing outbox=done, create queue-dispatch outbox
        ├─ insufficient/unavailable ─► Job=billing_rejected, outbox=done
        └─ transient failure ─► release/expire lease and retry same key
        │
        ▼
queue dispatcher publishes outside the transaction and records delivery
```

The repository includes that host-owned workflow, schema, and a bounded executable demo
under [`examples/job_outbox/`](../examples/job_outbox/README.md). The following command
uses real PostgreSQL while injecting an explicitly non-production, process-local billing
adapter, so it makes no Stripe request:

```bash
uv run --env-file .env python -m examples.job_outbox.demo --apply-schema
```

The demo exercises exact fractional amounts, same-request replay, charge and refund
outboxes, at-least-once dispatch, queue deduplication, stale execution-token rejection,
success, terminal failure, and bounded cleanup. The PostgreSQL tests separately inject
the real `EntitlementService`; replace the demo adapter with that service or the secured
internal client in production.

If the worker crashes after charge and before updating the host row, lease expiry causes
the same key to be retried. `replayed` then lets the workflow converge without a second
debit only if the host attempt is still charging. Every finalize statement must fence
the worker, for example with `WHERE state = 'processing' AND lease_token = :token`, and
must use a monotonic Job-state compare-and-set. A worker that lost its lease cannot mark
the outbox done or make the Job ready.

Queue publication is at least once: a crash after publish but before recording delivery
can publish twice. Create a separate dispatch outbox and make the queue consumer
idempotent on an immutable Job/dispatch ID.

Product failure may create one `refund_pending` outbox row only after the execution
lease has been revoked or the worker has stopped, using a terminal-failure compare-and-
set in the same host transaction. Otherwise work can continue successfully after its
credits were refunded. A failure before charge commits should cancel/fence the charge
attempt rather than issuing an out-of-order refund. Refund the original key only after
the charge is known to exist, and retry until a terminal result.

Recommended host-owned outbox fields include:

```text
id, job_id, operation, owner_external_ref, amount, credit_key,
state, attempts, available_at, lease_token, lease_expires_at,
last_error, created_at, updated_at
```

Here `amount` is an exact canonical decimal/atom string, not a floating-point column.

Charge and refund intentionally share one `CreditService` key, so do not put a blanket
`UNIQUE(credit_key)` across both outbox operations. Use `UNIQUE(operation, credit_key)`
or equivalent partial unique indexes, plus uniqueness for the logical Job/attempt and
operation. Keep these tables in host migrations; do not edit the billing baseline. A
different host database or a private internal HTTP API uses the same saga because
PostgreSQL and the remote billing service cannot share ACID.

Do not hold a host row lock or long transaction while calling Stripe. Billing plan
changes already follow their own durable remote-operation protocol.

## Standalone-service private APIs

The browser-facing API intentionally has no route that accepts an arbitrary account UUID
and charges credits. A separately deployed billing process can opt into the supplied
internal workload router, which accepts only stable `owner_external_ref` selectors and
resolves the internal account server-side.

Replace the final `install_billing` call in the host composition example with:

```python
from stripe_entitlements.internal_api import create_internal_router

from host.workload_auth import owner_authorizer, workload_auth

internal_router = create_internal_router(
    service_provider=lambda: kernel.services.entitlements,
    auth_adapter=workload_auth,
    owner_authorizer=owner_authorizer,
)
install_billing(
    app,
    kernel,
    prefix="/stripe",
    internal_routers=[internal_router],
)
```

This installs:

| Method | Effective route                          | Required scope       |
| ------ | ---------------------------------------- | -------------------- |
| POST   | `/stripe/internal/v1/entitlements/check` | `entitlements:check` |
| POST   | `/stripe/internal/v1/credits/charge`     | `credits:charge`     |
| POST   | `/stripe/internal/v1/credits/refund`     | `credits:refund`     |

`charge` and `refund` require the immutable `Idempotency-Key`; charge amounts are exact
decimal strings. Responses use no-store headers and exact decimal/atom balances.
Routes passed through `internal_routers` receive no-store/nosniff hardening, including
validation and not-found errors, but they do not inherit the public browser CORS/Origin
permission. Keep them behind a private service boundary. This hook is deliberately not
a generic public-extension mechanism.

Register every host `CORSMiddleware` before calling `install_billing`, and call the
installer last. When internal routers are present, startup fails closed if a Starlette
`CORSMiddleware` appears outside the billing middleware; otherwise that outer layer could
silently add browser CORS headers after the internal response was scrubbed. FastAPI cannot
inspect a reverse proxy or an arbitrary ASGI wrapper placed around the completed app, so
the host must also ensure those outer layers never add browser CORS to internal paths.
Prefer a separate private listener or service boundary when that contract cannot be
enforced.

Both security callbacks default to reject-all. `WorkloadIdentityAdapter` must validate
the complete service credential, including algorithm, issuer, audience, expiry,
not-before, revocation, and replay policy. Possessing a route scope is intentionally
insufficient to select every billing owner: `WorkloadOwnerAuthorizer` must separately
prove that this principal may perform this operation for this exact personal/tenant
owner. A global `credits:charge` scope must never become cross-tenant authority.

Mutual TLS, workload identity, or signed service tokens are deployment choices. A static
browser-visible token is not service authentication. The host should additionally audit
principal, owner, operation, and key, and reconcile unknown responses through its durable
outbox. The Job example supplies the saga/outbox mechanics, but the product must adapt its
tables and add its own workload-identity audit, grants, queue client, and operations.

## Connect or replace the Next.js frontend

The reference UI exposes a small TypeScript boundary:

```typescript
import type { AuthAdapter } from "@/lib/auth";
import { createHttpBillingApi } from "@/lib/http-api";

// oidcClient is supplied by the host application.
const auth: AuthAdapter = {
  kind: "production",
  async getAccessToken() {
    return oidcClient.getAccessToken();
  },
};

export const billingApi = createHttpBillingApi({
  baseUrl: process.env.NEXT_PUBLIC_BILLING_API_BASE_URL ?? "same-origin",
  auth,
});
```

Replace the composition in `web/lib/runtime.ts` or pass a host-created `BillingApi` to
the relevant components. The existing HTTP adapter sends an `Authorization: Bearer`
header and uses `credentials: "omit"`.

`same-origin` is the explicit mode for Vercel Services or another single-domain reverse
proxy. It creates relative `/api/...` requests. An empty string remains a configuration
error, and same-origin mode still rejects every call when the real auth adapter returns
no access token.

For an HttpOnly-cookie application, use a same-origin BFF that applies CSRF protection
and forwards a service/user credential, or deliberately change and test the transport.
The BFF must preserve a verifiable user and tenant context; one generic service token
must not become authority to select any billing owner.
Do not put a session, access token, Stripe secret, webhook secret, PaymentIntent client
secret or recovery URL in `localStorage`, analytics or source control.

The frontend's default development mode is mock. Connecting a real local backend
requires all of the following in `web/.env.local`:

```dotenv
NEXT_PUBLIC_BILLING_API_MODE=http
NEXT_PUBLIC_BILLING_API_BASE_URL=http://127.0.0.1:8000
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=<test-publishable-key>
NEXT_PUBLIC_DEMO_BEARER_TOKEN=<same-local-demo-token-as-the-backend>
```

The demo token is intentionally browser-visible and is allowed only with local
development, a Stripe test-mode backend and explicit demo configuration. Production
builds reject mock/demo authentication.

With the repository defaults, open the frontend at `http://localhost:3000`. Opening it
as `http://127.0.0.1:3000` produces a different browser Origin and state-changing calls
will be rejected unless `FRONTEND_ORIGINS`, Checkout success/cancel URLs and the Portal
return URL are changed to that exact origin. Production CORS entries must be bare HTTPS
origins. `CHECKOUT_SUCCESS_URL` itself must contain no query or fragment; target fields
are request-scoped and the server appends the Checkout Session placeholder.

## Customize the catalog deliberately

`plans.toml` defines stable plan keys, rank, monthly credits, features, limits and
monthly/yearly prices. The fully tested reference scope is deliberately bounded:

- USD and integer major-unit catalog prices;
- month and year intervals;
- one recurring Subscription item;
- explicit, monotonically increasing tier rank, credits, features and limits; and
- the two documented plan-change policies.

Changing a catalog requires one coordinated release:

1. update `plans.toml` and product enforcement;
2. synchronize `web/reference-catalog.json` and UI copy if the reference UI is used;
3. bootstrap/verify the matching Stripe Products and Prices in test mode;
4. run local, real test-mode and browser gates appropriate to the change;
5. bootstrap/verify live mode only during an approved production cutover; and
6. deploy every API and worker replica with identical catalog and policy settings.

`bootstrap_stripe.py` does not read `PLAN_CATALOG_PATH`; its independent `--catalog`
argument defaults to the repository root `plans.toml`. For a custom path, pass the same
file explicitly:

```bash
uv run --env-file .env python scripts/bootstrap_stripe.py \
  --catalog path/to/the-same-plans.toml
```

The account row stores `plan_key`, not a catalog revision or entitlement snapshot.
Changing features, limits or monthly credits can therefore reinterpret an existing
subscriber under the newly deployed catalog. Applications that promise grandfathered
plans must add immutable plan revisions and a migration/cutover policy before changing
the catalog.

## Complete the real test-mode setup

The README Quick Start launches a safe local skeleton, not an automatic first-payment
lifecycle. The secret key used by bootstrap/backend, the Stripe CLI login, and the
publishable key used by the browser must all belong to the same Stripe test account.
Confirm the account identity in the Dashboard/CLI login and copy the key pair from that
account without printing either key.

Before expecting real Checkout to work:

1. replace every placeholder in a mode-0600 ignored `.env`;
2. use `uv run --env-file .env` for commands that require those values;
3. bootstrap the test catalog and copy the reported real Portal configuration ID into
   `STRIPE_PORTAL_CONFIGURATION_ID`;
4. verify that the Portal ID configured by the API is the safe one reported by bootstrap;
5. start Stripe CLI signed forwarding and copy its temporary signing secret into `.env`;
6. discover `STRIPE_WEBHOOK_API_VERSION` from an actual signed delivery rather than
   copying `STRIPE_API_VERSION`, using the diagnostic procedure below;
7. restart the API after changing either webhook setting; and
8. switch the frontend from mock to HTTP mode with the matching local demo token and
   test publishable key.

`STRIPE_API_VERSION` and `STRIPE_WEBHOOK_API_VERSION` are independent contracts. A
mismatch deliberately creates a durable incident and does not grant entitlement.
`stripe trigger invoice.paid` is useful as a signature/transport diagnostic but normally
has no matching repository account or intent, so it is not a product lifecycle test.

### Discover a local Stripe CLI payload version

Stripe CLI prints its temporary signing secret before it has delivered an Event, but it
may not print the future Event payload's `api_version`. When the actual version is not
already established:

1. put the listener's real temporary signing secret and a syntactically valid candidate
   webhook version in `.env`;
2. start the API and keep the listener running;
3. send one explicit test-only diagnostic Event with `stripe trigger invoice.paid`;
4. read the version from the redacted snapshot of the signed Event that reached the
   local database:

```bash
docker compose exec -T postgres \
  psql -U postgres -d stripe_entitlements -Atc \
  "select distinct payload->>'api_version'
     from stripe_webhook_events
    where received_at > now() - interval '5 minutes'"
```

5. require exactly one non-empty version, write it to
   `STRIPE_WEBHOOK_API_VERSION`, and restart the API; and
6. only then begin the real Checkout lifecycle.

The diagnostic delivery may be stored as `webhook_contract_mismatch` or as an unknown
account incident. That durable record proves signature transport/version discovery only;
it is not entitlement success. Use a fresh disposable database for clean release
evidence rather than deleting inbox/incident rows to make a failed run look successful.

For a reproducible real browser sequence—decline, 3DS, signed webhook, account
projection and upgrade—use [the browser E2E runbook](BROWSER_E2E.md). Do not place
test-mode secrets directly in shell history; use an ignored env file or secret manager.

## Schedule workers and operate the dependency chain

The API process does not run background schedules. Invoke these one-shot commands from
Kubernetes CronJobs, Vercel Cron, Railway Cron, systemd timers or another scheduler:

```bash
# Hourly
uv run --env-file /run/secrets/billing.env stripe-entitlements grant-due

# Every five minutes (subscription and credit-pack recovery)
uv run --env-file /run/secrets/billing.env stripe-entitlements reconcile
```

Those commands are convenient from a source checkout. A built image or installed Wheel
can invoke the console script directly while the platform injects environment variables:

```bash
stripe-entitlements grant-due
stripe-entitlements reconcile
```

Multiple schedulers are safe. The reconciliation command covers both recurring Invoice
state and persisted credit-pack Session/PaymentIntent/Charge state. No scheduler means
annual monthly grants or webhook-loss repair can be delayed. API and worker replicas
must share the PostgreSQL primary,
catalog, product line, transition policy and Stripe version contracts.

The Vercel topology schedules secured bounded HTTP wrappers instead of the unbounded
CLI drain loop. That is intentional for Function duration limits. Overlapping requests
remain safe, a failed page returns 503 for retry, and later ticks continue the backlog.
See [the Vercel deployment guide](VERCEL.md#what-the-checked-in-configuration-does).

At minimum monitor database health, unresolved incidents, webhook 5xx/delivery age,
scheduler lag, stale plan changes, reconciliation failures and backup freshness. See
[Operations](OPERATIONS.md) and [Distributed deployment](DISTRIBUTED.md).

## Production cutover

Use [the repository release checklist](../.github/RELEASE_CHECKLIST.md) for complete
evidence. The integration-specific order is:

1. while Checkout/customer traffic is still disabled, create the final live webhook
   endpoint with only the nine supported Event types and an explicitly pinned payload
   version; put its real signing secret, the live Stripe key, database URL and public URL
   settings into the production secret manager;
2. provision the dedicated production database, restore-test its backup policy, and
   apply migrations before sending traffic:

   ```bash
   uv run --env-file /run/secrets/billing-live.env \
     stripe-entitlements migrate
   ```

   The migration command loads only `DATABASE_URL` and optional `DATABASE_POOL_*`
   bounds. Prefer a database-only secret for
   this schema-init Job; it does not need the live Stripe key, webhook signing secret, or
   browser configuration. Supply the complete runtime contract separately to API and
   worker processes.

3. configure `APP_ENV=production`, remove `DEMO_BEARER_TOKEN`, and configure the
   deployment to use only the host-owned entrypoint with production authentication and
   authorization;
4. bootstrap the live catalog only after explicit approval, then verify it and manually
   copy/compare the reported live Portal configuration ID:

   ```bash
   uv run --env-file /run/secrets/billing-live.env \
     python scripts/bootstrap_stripe.py --catalog plans.toml --allow-live
   uv run --env-file /run/secrets/billing-live.env \
     python scripts/bootstrap_stripe.py --catalog plans.toml --verify-only
   ```

5. start API/worker processes behind a traffic gate and verify database health and
   authenticated billing-admin access;
6. verify that the endpoint from step 1 remains limited to
   `checkout.session.completed`, `checkout.session.expired`, `invoice.paid`,
   `invoice.payment_failed`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `charge.refunded`, `charge.dispute.created`, and
   `payment_intent.succeeded`;
7. independently verify its actual
   signed payload version; test-mode evidence is not live-payload evidence;
8. configure HTTPS Checkout success/cancel and Portal return URLs plus exact bare HTTPS
   `FRONTEND_ORIGINS` entries;
9. replace the frontend runtime composition with production auth/BFF code, set HTTP API
   and canonical-site variables before `npm run build`, and keep demo auth disabled;
10. set `NEXT_PUBLIC_ALLOW_INDEXING=true` only for the canonical public site, never a
    staging or preview deployment;
11. enable hourly annual grants, five-minute reconciliation, incidents/webhook/scheduler alerts
    and backup monitoring; and
12. run host contract tests, repository gates, a low-risk live delivery/payment-recovery
    smoke, and a low-traffic observation window before increasing traffic.

Test and live Products, Prices, Portal configurations, webhook endpoints, Events and
credentials are separate inventories. Never copy test identifiers into live settings or
place a backend credential in any `NEXT_PUBLIC_*` variable.

## Host integration contract tests

The repository's tests prove the billing kernel, not the host integration. Add tests at
the boundary you own:

- an invalid or expired token cannot create a billing account;
- a forged tenant selector and cross-tenant membership both fail;
- a viewer can read catalog/sanitized product state but cannot fetch a recovery URL;
- a viewer receives 403 from `/api/account` and every billing mutation;
- concurrent resolution of one `external_ref` produces one billing account;
- concurrent calls for one job key charge once and replay thereafter;
- the same key with another account or amount fails;
- a worker crash after charge converges by replay before the Job is queued;
- a refunded attempt followed by a stale charge replay cannot revive the Job;
- a worker that lost its lease cannot finalize, and every finalize write checks its
  fencing token;
- insufficient credits, revoked entitlement and expired credit windows never queue work;
- concurrent refunds apply once, and `epoch_expired` is terminal;
- charge/refund reordering, execution-lease loss, and success/failure races converge
  without free work or a double debit;
- a Job without a committed charge never executes;
- duplicate queue delivery executes one logical Job effect;
- file/page, concurrent-job and API-key limits are enforced in host storage;
- frontend token refresh, logout and tenant switching cannot reuse another account;
- an unverified email is never forwarded to Stripe;
- HttpOnly-cookie/BFF flows include CSRF tests; and
- service A cannot check, charge or refund tenant B without an explicit owner-bound
  scope; expired/replayed service credentials fail;
- catalog changes have an explicit existing-customer/grandfathering expectation.

Also run the repository's network-free PostgreSQL suite. Run real Stripe and browser
gates whenever the integration changes Stripe object shape, identity metadata, URLs,
Portal policy, frontend auth or plan-transition behavior.

## Production adoption checklist

- [ ] Choose one billable-owner rule and document its immutable `external_ref` encoding.
- [ ] Implement token/session verification, tenant membership and billing-admin scopes.
- [ ] Start through a host-owned entrypoint that injects `AuthAccountAdapter`.
- [ ] Use a dedicated, migrated PostgreSQL database and test complete backup/restore.
- [ ] Enforce feature and numeric limits in the product backend.
- [ ] Coordinate Jobs and credits through a durable outbox/saga.
- [ ] If billing is separate, configure the internal router with workload authentication
      and explicit workload-to-owner authorization.
- [ ] Configure the real test/live Portal IDs and independently verified webhook versions.
- [ ] Keep test and live Products, Prices, endpoints and secrets separate.
- [ ] Deploy hourly annual grants and five-minute reconciliation.
- [ ] Implement production frontend auth or a same-origin BFF.
- [ ] Decide identity merge/deletion and catalog-grandfathering policy.
- [ ] Pass host contract tests, repository tests and the applicable real Stripe gates.
- [ ] Alert on incidents, webhook failures, scheduler lag and database recovery health.

## Current portability assessment

The smallest boundary—mapping a verified host identity to one billing account—is simple
and deliberately independent of a particular identity provider. The difficult part is
not the `external_ref`; it is coordinating tenant authorization, product state and
credits without weakening the billing invariants.

For a Python/FastAPI product using dedicated PostgreSQL, both standalone and native
same-process adoption are practical through the implemented app/router/service facade.
For a Node/Next.js product, the independent TypeScript runtime, Fetch facade, Node CLI,
and App Router handlers provide the same billing boundary without a Python or Railway
deployment. The split Next.js + FastAPI Vercel Services topology remains an alternative;
both use one same-origin public route table and the same PostgreSQL contract.
The personal/team JWT starters and owner-bound internal API remove common bootstrap
work, while leaving issuer configuration, tenant membership, and service-to-owner grants
under host control. ORM models, cookie/BFF auth, a transactional Job/outbox workflow,
and generated clients for languages other than Python/TypeScript still require explicit
host integration.
