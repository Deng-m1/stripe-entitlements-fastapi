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

The access token must have a canonical, non-zero UUID `sub`, an exact `iss` and `aud`,
and signed `exp`, `nbf`, and `kid` values. The configured algorithm list accepts only
asymmetric algorithms. The verifier forwards `email` as a Checkout hint only when the
signed `email_verified` claim is exactly `true`.

## Personal subscription owner

Start the personal-user template with:

```bash
uv run --env-file .env uvicorn \
  examples.auth_starters.personal_app:create_host_app \
  --factory --host 0.0.0.0 --port 8000
```

A verified subject `016e744f-17c9-46c5-96ab-95179f2b830d` maps deterministically to
`v1:user:016e744f-17c9-46c5-96ab-95179f2b830d`. A user/account header never participates
in that mapping.

## Team subscription owner

The team template expects the signed token to contain a canonical `tenant_id` UUID. It
still treats that claim only as a selector: every request queries the host-owned
membership table for the verified `(sub, tenant_id)` pair.

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
an owner.

The built-in team policy is fail-closed:

| Role | Catalog | Account/recovery URL | Checkout | Portal | Plan change |
| --- | --- | --- | --- | --- | --- |
| `viewer` | Allowed | Denied | Denied | Denied | Denied |
| `billing_admin` | Allowed | Allowed | Allowed | Allowed | Allowed |

Unknown routes are denied to viewers. When adding a new viewer-facing billing route,
extend the explicit route-to-capability policy and its tests instead of authorizing by
HTTP method alone.
