# Adopting the reference in an existing application

This guide explains how to connect the repository to an existing user system,
organization model, product jobs, and frontend. It distinguishes code this repository
already implements from policy and coordination that the host application must own.

The current main branch is best adopted as a complete source template or a standalone
billing service. It is not yet a drop-in router, identity plugin, or language-neutral
billing SDK.

This guide assumes a source checkout. Until a matching 0.3 tag and published artifact
exist, pin the exact reviewed commit rather than assuming that the latest older tag or a
package index contains this code. The built Wheel contains the Python package, migrations
and catalog, but not top-level operator scripts such as `scripts/bootstrap_stripe.py`.

## Contents

- [Responsibility and deployment choices](#responsibility-boundary)
- [Runtime and host-system dependencies](#runtime-dependencies)
- [Users, tenants and other host entities](#define-the-billable-owner-first)
- [Authentication, authorization and FastAPI composition](#connect-authentication-and-tenant-authorization)
- [Entitlement enforcement](#enforce-product-entitlements-on-the-server)
- [Credits and durable Job coordination](#associate-credits-with-product-jobs)
- [Standalone-service private APIs](#standalone-service-private-apis)
- [Next.js or replacement frontend](#connect-or-replace-the-nextjs-frontend)
- [Catalog customization](#customize-the-catalog-deliberately)
- [Real test-mode setup](#complete-the-real-test-mode-setup)
- [Schedulers and production cutover](#schedule-workers-and-operate-the-dependency-chain)
- [Host contract tests](#host-integration-contract-tests)

## Responsibility boundary

| Capability | Repository | Host application |
| --- | --- | --- |
| Stripe Checkout, Portal, plan changes and signed webhooks | Implemented | Configure and operate |
| Duplicate, delayed, concurrent and out-of-order Event handling | Implemented | Preserve the database invariants |
| Billing account resolution from one stable subject | Implemented | Choose and verify that subject |
| Session, JWT or OIDC verification | Adapter protocol only | Implement |
| Tenant membership and billing-admin authorization | Not implemented | Implement |
| Catalog, account and billing mutation HTTP APIs | Implemented | Authenticate and consume |
| Atomic credit charge/refund primitive | Implemented in Python | Associate it with product work |
| Job creation plus credit charge as one business workflow | Not implemented | Add an outbox/saga and repair loop |
| Feature and numeric-limit enforcement | Returned as data | Enforce in the product backend |
| Concurrent-job and API-key limits | Returned as data | Enforce transactionally in host tables |
| Production frontend authentication | TypeScript adapter only | Implement or add a BFF |
| Annual grants and reconciliation | Commands implemented | Schedule and monitor |
| Identity merge, transfer, deletion and plan grandfathering | Not implemented | Define and implement |

## Choose an adoption shape

| Shape | Current fit | Use when | Important limitation |
| --- | --- | --- | --- |
| Fork the complete repository | Best supported | Building a new FastAPI billing boundary | You own future upstream merges |
| Standalone billing service | Supported | The host is large, separately deployed or not Python | There is no internal credit charge/refund HTTP API yet |
| Same-process FastAPI composition | Possible with adaptation | The host is Python and can use this app as its root | `create_app` returns a complete app, not an `APIRouter` |
| Install as a generic SDK | Not currently supported | — | No stable service facade or published identity plugins |

For an existing application, the standalone-service boundary is currently the safest
path. A new same-process application can make the billing app its root and add host
routers, but migrating an existing root app requires deliberate lifespan, middleware,
state and path composition. Mounting it as a sub-application is not a supported
copy-paste path.

For a standalone service, the browser-facing billing APIs are usable after injecting
real authentication. Product credit charging still needs either a private service API
or an asynchronous integration owned by the host. Never expose `CreditService` directly
to a browser.

## Runtime dependencies

The repository does not require the host to use a particular user ORM, job queue, or
identity provider. Its hard runtime assumptions are narrower but significant:

- Python 3.12+, FastAPI and the bundled Python dependencies for the billing API;
- PostgreSQL as both durable state and the distributed coordination layer;
- `asyncpg` and the repository's unqualified SQL schema for in-process database access;
- one Stripe account/mode, one product line, one recurring Subscription item and USD;
- a public signed Stripe webhook endpoint;
- an external scheduler for annual grants and reconciliation; and
- Node.js 22+ and npm only when reusing the Next.js reference UI.

Redis, Celery and a particular JWT library are not required. If the host uses SQLAlchemy,
Django ORM, another database, or another language, run billing as a separate service
rather than letting application code write its tables.

Production should use a dedicated billing database. The migration creates
`schema_migrations`, ten correctness tables, a function and a trigger in the current
PostgreSQL `search_path`; there is no `BILLING_DB_SCHEMA` namespace setting. The ten
tables must be backed up and restored as one unit.

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

| Existing host | Integration effort | Reason |
| --- | --- | --- |
| FastAPI plus verified Bearer JWT/OIDC | Moderate | The auth protocol matches naturally; tenant authorization is still host-owned |
| FastAPI plus server session/HttpOnly cookie | Moderate in one process | The backend adapter can read the cookie; the reference browser client needs a BFF or transport change |
| SQLAlchemy or Django application | Moderate as a sidecar | Billing uses fixed `asyncpg` SQL and does not expose ORM models |
| Non-Python service | Higher | Public billing HTTP works, but entitlement checks and credit charge/refund need private APIs |
| User-only SaaS | Lower | One immutable user subject maps directly to one billing account |
| Multi-tenant/team SaaS | Higher | Membership, selected-tenant validation, billing roles and tenant lifecycle remain host concerns |
| Existing job queue/workflow engine | Moderate to high | The queue is unrestricted, but charge/job atomicity needs a durable saga/outbox |

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

| Product model | Stable billing subject |
| --- | --- |
| One subscription per person | `v1:user:<immutable-user-uuid>` |
| One subscription shared by organization members | `v1:tenant:<immutable-tenant-uuid>` |
| A user in several independently billed organizations | One tenant subject per organization |

`external_ref` is globally unique in `billing_accounts`, contains 1–512 visible UTF-8
bytes, and resolves to one internal billing account. That account owns at most one Stripe
Customer and one Subscription in the implemented model.

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

| Host entity | Required coupling to billing |
| --- | --- |
| User | One immutable ID only for personal billing; no billing FK is required |
| Tenant/organization | One immutable ID for team billing; membership stays in the host |
| Membership/role | Verified on every relevant request; no role is stored by billing |
| Job/conversion/AI call | Immutable attempt key plus host outbox state; no built-in Job FK |
| Uploaded file or request input | Host validates catalog feature and numeric limits |
| API key | Host stores/counts keys transactionally against the catalog limit |
| Queue worker | Host owns execution leases, fencing and idempotent delivery |
| Stripe Customer/Subscription | Billing-owned; host must not use either as user identity |

An optional host table can map `(owner_kind, owner_id)` to `external_ref` for lifecycle
and audit, but a deterministic encoding often makes it unnecessary. Do not add a foreign
key from the host database to billing tables when the services have independent backup,
deployment or availability boundaries.

## Connect authentication and tenant authorization

[`AuthAccountAdapter`](../src/stripe_entitlements/auth.py) is the production identity
boundary. The adapter receives a FastAPI `Request` and returns a verified
`AuthenticatedIdentity`. The safe default rejects every protected request.

The following skeleton shows the required separation. `TokenVerifier` and
`MembershipRepository` are host-owned interfaces, not classes supplied by this package.

```python
# host/auth.py
from dataclasses import dataclass
from typing import Protocol
from uuid import UUID

from fastapi import HTTPException, Request

from stripe_entitlements.auth import (
    AuthenticatedIdentity,
    AuthenticationError,
)

from host.billing_owner import BillingOwner


@dataclass(frozen=True, slots=True)
class HostPrincipal:
    user_id: UUID
    selected_tenant_id: UUID
    email: str | None
    email_verified: bool


@dataclass(frozen=True, slots=True)
class Membership:
    can_manage_billing: bool


class InvalidHostCredential(RuntimeError):
    pass


class TokenVerifier(Protocol):
    async def verify(self, request: Request) -> HostPrincipal: ...


class MembershipRepository(Protocol):
    async def require_membership(
        self,
        user_id: UUID,
        tenant_id: UUID,
    ) -> Membership | None: ...


class HostAuthAdapter:
    def __init__(
        self,
        tokens: TokenVerifier,
        memberships: MembershipRepository,
    ) -> None:
        self.tokens = tokens
        self.memberships = memberships

    async def authenticate(self, request: Request) -> AuthenticatedIdentity:
        try:
            principal = await self.tokens.verify(request)
        except InvalidHostCredential as exc:
            raise AuthenticationError("invalid host session") from exc

        membership = await self.memberships.require_membership(
            principal.user_id,
            principal.selected_tenant_id,
        )
        if membership is None:
            raise HTTPException(403, "tenant membership required")
        catalog_paths = {"/api/catalog", "/billing/catalog"}
        if (
            request.url.path not in catalog_paths
            and not membership.can_manage_billing
        ):
            raise HTTPException(403, "billing administrator permission required")

        owner = BillingOwner("tenant", principal.selected_tenant_id)
        checkout_email = principal.email if principal.email_verified else None
        return AuthenticatedIdentity(owner.external_ref, checkout_email)
```

The token verifier must validate the host's normal security contract, including the
signature, accepted algorithm, issuer, audience, expiry, not-before value and any
revocation/session rules. A decoded but unverified JWT is not authentication.

Catch only explicit invalid/expired credential failures as `AuthenticationError`. The
host verifier should map a known identity-provider outage to a sanitized 503. Unknown
exceptions must remain 500 errors rather than being disguised as bad credentials and
forcing a user logout.

A selected-tenant claim, route parameter, cookie or header is only a selector. The
membership repository must prove that the authenticated user currently belongs to that
tenant. A bare `X-Tenant-ID`, `X-User-ID`, query parameter, request body field or email
must never become `external_ref` directly.

Pass an email to Stripe only when the host identity provider has verified it. Otherwise
return `email=None`; email remains an optional Checkout hint.

The current adapter protocol is authentication-first and has no separate authorization
object or scope hook. Raising `HTTPException(403)` as above works for this app, but
authorization remains host policy. Do not authorize only by HTTP method:
`GET /api/account` can contain a Stripe hosted-invoice recovery URL, which is a payment
capability. Team viewers should receive only catalog/sanitized product entitlement data;
billing administrators may receive the full account view. Applications with viewer,
billing-admin and owner roles should preferably enforce path/capability scopes in a
same-origin BFF or add a first-class authorization adapter.

## Compose the FastAPI application

For a new root application, use a host-owned ASGI entrypoint so production never starts
with the default `RejectAllAuthAdapter`:

```python
# host_billing.py
from stripe_entitlements.app import create_app
from stripe_entitlements.config import get_settings
from stripe_entitlements.database import Database

from host.auth import HostAuthAdapter, memberships, tokens
from host.routes import product_router


def create_host_app():
    settings = get_settings()  # reads the process environment
    database = Database(settings.database_url)
    app = create_app(
        settings,
        database=database,
        auth_adapter=HostAuthAdapter(tokens, memberships),
    )
    app.include_router(product_router)
    return app
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

The snippet is not a complete migration recipe for an existing FastAPI root. Before
using same-process composition, explicitly merge and test:

- both applications' lifespan/startup/shutdown behavior;
- middleware order, exception handlers, tracing, metrics and security headers;
- app state and database-pool ownership;
- CORS and trusted origins (the billing middleware also sees host routes);
- OpenAPI metadata and route-prefix conflicts; and
- readiness semantics and graceful shutdown.

`include_router` moves routes; it does not import another app's lifespan, middleware or
state. If these concerns are already established in a large host, deploy billing as a
standalone service until the project exposes a router/service facade designed for
composition.

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

The product backend must fail closed and check, at minimum:

1. the authenticated request resolves to the expected billable owner;
2. `entitlements_enforceable` is true;
3. the required feature is present;
4. file size, page count or another numeric input is within its limit; and
5. any credit charge has committed before expensive work starts.

Never authorize from a browser redirect, Checkout Session URL, `confirm` response,
mutable Stripe Subscription read, or cached client-side account JSON.

Static limits require host behavior:

| Entitlement | Enforcement point |
| --- | --- |
| Feature flag such as `api_access` | API authorization before work starts |
| `max_file_mb` / `max_pages_per_job` | Request validation before upload/queue admission |
| `concurrent_jobs` | Transactional host job lease/count |
| `api_keys` | Transactional host API-key table constraint |
| Monthly credits | `CreditService.charge` before execution |

There is currently no public Python `EntitlementService` or `/internal/check` endpoint.
In-process hosts may load the same `PlanCatalog`, but a standalone deployment needs a
private server-to-server check API or may forward/exchange the current user's trusted
credential to consume `/api/account`. A generic service token resolves only to whatever
subject its adapter assigns; it cannot select an arbitrary owner through this API.
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

The module is importable from source and the built Wheel, but it is not yet exposed as a
versioned public service facade. Pin a repository release/commit and cover the wrapper
with host contract tests before depending on it in process.

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
        row = await self.database.existing_account_for_external_ref(
            owner.external_ref
        )
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
        result = await CreditService(
            self.database.require_pool()
        ).charge(account_id, amount, key)
        return key, result

    async def refund(self, key: str):
        return await CreditService(self.database.require_pool()).refund(key)
```

An integer amount retains the historical meaning of whole credits. Use a decimal string,
`Decimal`, or `CreditAmount` for fractions; binary `float` is rejected. Store the
canonical decimal or atom string in a host outbox so another language cannot reinterpret
the request before an idempotent replay. `CreditResult.balance` is a `CreditAmount`, with
the exact persisted value available as `balance.atoms` or `balance_atoms`.

Result and error semantics matter:

- `charged` / `refunded`: this call committed the effect;
- `replayed` from `charge`: a matching debit row exists, but it may already have been
  refunded; it is not proof that the Job may start;
- `replayed` from `refund`: that debit was already refunded; the returned balance is
  current, not a historical transaction balance;
- `epoch_expired`: a refund arrived after the funding epoch closed and cannot recreate
  old credits;
- `InsufficientCreditsError`: do not start the job;
- `CreditsUnavailableError`: the subscription, revocation or credit window blocks use;
- `ValueError`: the key or parameters conflict and require investigation; and
- `KeyError` from refund: no matching debit exists and the workflow is out of order.

Refund must reuse the original charge key. If a refunded job is attempted again, create
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

The public API intentionally has no route that accepts an arbitrary account UUID and
charges credits. Adding such a route without a service boundary would create an account
takeover and denial-of-wallet risk.

A host that deploys billing separately must add a private API or message consumer that:

- authenticates the calling service with validated issuer, audience, expiry and replay
  controls, not an end-user browser credential;
- requires an explicit operation scope such as check, charge or refund;
- authorizes that workload and operation for the requested owner/tenant;
- accepts the stable owner reference plus immutable business-operation identity;
- resolves the owner reference server-side to the internal account UUID;
- rejects a caller-supplied Stripe Customer or Subscription as authority;
- binds owner, amount and operation to the same idempotency/outbox identity;
- preserves `CreditService` error and replay semantics; and
- records caller, owner, operation and key for audit and unknown-response reconciliation.

Mutual TLS, workload identity or signed service tokens are deployment choices. A static
browser-visible token is not service authentication.

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
  baseUrl: process.env.NEXT_PUBLIC_BILLING_API_BASE_URL!,
  auth,
});
```

Replace the composition in `web/lib/runtime.ts` or pass a host-created `BillingApi` to
the relevant components. The existing HTTP adapter sends an `Authorization: Bearer`
header and uses `credentials: "omit"`.

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
origins.

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
Kubernetes CronJobs, Railway Cron, systemd timers or another scheduler:

```bash
# Hourly
uv run --env-file /run/secrets/billing.env stripe-entitlements grant-due

# Daily
uv run --env-file /run/secrets/billing.env stripe-entitlements reconcile
```

Those commands are convenient from a source checkout. A built image or installed Wheel
can invoke the console script directly while the platform injects environment variables:

```bash
stripe-entitlements grant-due
stripe-entitlements reconcile
```

Multiple schedulers are safe. No scheduler means annual monthly grants or webhook-loss
repair can be delayed. API and worker replicas must share the PostgreSQL primary,
catalog, product line, transition policy and Stripe version contracts.

At minimum monitor database health, unresolved incidents, webhook 5xx/delivery age,
scheduler lag, stale plan changes, reconciliation failures and backup freshness. See
[Operations](OPERATIONS.md) and [Distributed deployment](DISTRIBUTED.md).

## Production cutover

Use [the repository release checklist](../.github/RELEASE_CHECKLIST.md) for complete
evidence. The integration-specific order is:

1. while Checkout/customer traffic is still disabled, create the final live webhook
   endpoint with only the eight supported Event types and an explicitly pinned payload
   version; put its real signing secret, the live Stripe key, database URL and public URL
   settings into the production secret manager;
2. provision the dedicated production database, restore-test its backup policy, and
   apply migrations before sending traffic:

   ```bash
   uv run --env-file /run/secrets/billing-live.env \
     stripe-entitlements migrate
   ```

   The current migration command loads the complete `Settings` object even though it
   only mutates PostgreSQL. Its env file must therefore already contain the real live
   Stripe/webhook contract; do not use format-valid fake credentials to make migration
   start.

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
   `customer.subscription.deleted`, `charge.refunded`, and `charge.dispute.created`;
7. independently verify its actual
   signed payload version; test-mode evidence is not live-payload evidence;
8. configure HTTPS Checkout success/cancel and Portal return URLs plus exact bare HTTPS
   `FRONTEND_ORIGINS` entries;
9. replace the frontend runtime composition with production auth/BFF code, set HTTP API
   and canonical-site variables before `npm run build`, and keep demo auth disabled;
10. set `NEXT_PUBLIC_ALLOW_INDEXING=true` only for the canonical public site, never a
   staging or preview deployment;
11. enable hourly annual grants, daily reconciliation, incidents/webhook/scheduler alerts
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
- a viewer receives 403 from `/api/account` and every billing mutation unless a
  role-aware response layer removes every privileged capability;
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
- [ ] Add a service-authenticated credit API only if billing is separately deployed.
- [ ] Configure the real test/live Portal IDs and independently verified webhook versions.
- [ ] Keep test and live Products, Prices, endpoints and secrets separate.
- [ ] Deploy hourly annual grants and daily reconciliation.
- [ ] Implement production frontend auth or a same-origin BFF.
- [ ] Decide identity merge/deletion and catalog-grandfathering policy.
- [ ] Pass host contract tests, repository tests and the applicable real Stripe gates.
- [ ] Alert on incidents, webhook failures, scheduler lag and database recovery health.

## Current portability assessment

The smallest boundary—mapping a verified host identity to one billing account—is simple
and deliberately independent of a particular identity provider. The difficult part is
not the `external_ref`; it is coordinating tenant authorization, product state and
credits without weakening the billing invariants.

For a Python/FastAPI product willing to fork the source and use dedicated PostgreSQL,
adoption is practical today. For an existing service that expects a router, ORM models,
cookie auth, a transactional Job API or language-neutral RPC, integration still requires
an explicit adapter layer. Those dependencies are visible and bounded in this guide, but
they are not implemented by the repository yet.
