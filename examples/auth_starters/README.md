# Production JWT authentication starters

Install the optional verifier and apply the billing schema first:

```bash
uv sync --extra auth
uv run --env-file .env stripe-entitlements migrate
```

Both starters require the normal billing environment plus these values:

```dotenv
AUTH_JWT_ISSUER=https://identity.example.com/
AUTH_JWT_AUDIENCE=billing-api
AUTH_JWKS_URL=https://identity.example.com/.well-known/jwks.json
AUTH_JWT_ALGORITHMS=RS256
```

The access token must have a bounded, non-empty string `sub`, an exact `iss` and `aud`,
a signed integer `exp`, and a `kid`; `nbf` is optional, but must be a valid signed integer
when present. UUID subjects and opaque provider subjects such as `user_...` or
`auth0|...` are preserved exactly. The configured algorithm list accepts only asymmetric
algorithms. The verifier forwards `email` as a Checkout hint only when the signed
`email_verified` claim is exactly `true`.

## Personal subscription owner

Start the personal-user template with:

```bash
uv run --env-file .env uvicorn \
  examples.auth_starters.personal_app:create_host_app \
  --factory --host 0.0.0.0 --port 8000
```

A verified subject `user_provider_123` maps deterministically to
`v1:user:user_provider_123`. A user/account header never participates in that mapping.

## Team subscription owner

The team template expects the signed token to contain a bounded, stable `tenant_id`
string. It still treats that claim only as a selector: every request queries the
host-owned membership table for the verified `(sub, tenant_id)` pair. The example stores
both IDs as text so UUID and opaque identity-provider IDs such as `org_...` work; a real
product should adapt the repository to its existing key types. The example's `C`
collation keeps those selectors case-sensitive. If the provider names the
signed selector `org_id` or something else, pass that exact name as
`tenant_claim="org_id"` when constructing `TeamJwtAuthAdapter`; do not copy it from an
unsigned header.

Apply the example host tables, create the corresponding user, tenant, and membership,
then start the app:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f examples/auth_starters/team_schema.sql

uv run --env-file .env uvicorn \
  examples.auth_starters.team_app:create_host_app \
  --factory --host 0.0.0.0 --port 8000
```

Replace the example tables with the product's existing membership repository in a real
host application. Keep the lookup server-side and active on every request; do not turn an
`X-Tenant-ID`, route parameter, billing account ID, email, or unverified JWT payload into
an owner. Return the exact verified user and tenant selectors supplied to the repository;
the adapter rejects a row for a normalized, stale, or different identity.

The built-in team policy is fail-closed:

| Role | Catalog | Account/recovery URL | Subscription/pack Checkout | Portal | Plan change |
| --- | --- | --- | --- | --- | --- |
| `viewer` | Allowed | Denied | Denied | Denied | Denied |
| `billing_admin` | Allowed | Allowed | Allowed | Allowed | Allowed |

Unknown routes are denied to viewers. When adding a new viewer-facing billing route,
extend the explicit route-to-capability policy and its tests instead of authorizing by
HTTP method alone.
