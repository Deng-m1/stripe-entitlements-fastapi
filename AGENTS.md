# Agent Operating Guide

This repository is billing infrastructure. Optimize for explicit invariants and
reproducible evidence, not short diffs.

## Repository identity and mandatory discovery

This is a dual-runtime repository. The historical `fastapi` repository slug must not be
used to classify the whole project as Python-only:

- `src/stripe_entitlements/` is the native Python/FastAPI billing backend;
- `typescript/src/` is an independent native TypeScript/Node billing backend, not a
  browser client or Python proxy;
- `typescript/src/next/` adapts that backend to Next.js App Router Route Handlers; and
- `web/app/` is the reference Next.js App Router application, including SSR pages,
  server API/webhook/health routes, metadata, robots, and sitemap handling.

Before claiming that a runtime, SSR path, framework adapter, or deployment shape is
missing—and before reimplementing one—inspect `pyproject.toml`, `typescript/package.json`,
`web/package.json`, the four directories above, and the matching README/adoption section.
Choose one server runtime for a normal deployment, but review both implementations when
making repository-wide architecture or parity claims.

## Required reading

Before changing behavior, read these files completely:

1. `docs/INVARIANTS.md`
2. `docs/ARCHITECTURE.md`
3. `docs/DISTRIBUTED.md`
4. `docs/TESTING.md`
5. `typescript/README.md` when touching TypeScript, Node, or Next.js behavior
6. `web/README.md` when touching the reference application
7. `docs/STRIPE_CLI.md` when touching Stripe API or CLI behavior

## Security rules

- Never print, commit, paste, or log `sk_*`, `rk_*`, or `whsec_*` values.
- Automated real tests must reject `sk_live_` before making any network call.
- Never run destructive cleanup against an object not created by the current test run.
- Do not use production databases for tests. The default suite owns a disposable Docker
  PostgreSQL container bound to `127.0.0.1`.
- Verify webhook signatures from the exact raw request body before JSON parsing.
- Do not add network calls inside a PostgreSQL transaction.

## Lock and transaction discipline

- Claim the Stripe event and apply all database effects in the same transaction.
- Lock `billing_accounts` before `stripe_invoice_state` whenever both are needed.
- Keep the order consistent across paid, refund, dispute, and annual worker paths.
- Every entitlement grant needs a database-enforced business idempotency key.
- Fail-closed paths that return 2xx must create or update a durable incident.
- A processing exception must roll back the event inbox row so Stripe can retry.

## Commands

Run the gates for every runtime changed by the task. Repository-wide billing or policy
changes require both backend suites; Web/Next.js changes also require the Web gates.

```bash
# Python/FastAPI
uv sync
uv run ruff check .
uv run mypy src
uv run pytest -m "not real_stripe"

# TypeScript/Node billing backend
cd typescript
npm ci
npm run check

# Next.js reference application
cd ../web
npm ci
npm run lint
npm run typecheck
npm test
npm run build

# Repository root
cd ..
git diff --check
```

Real Stripe tests are a separate, explicit gate:

```bash
test "${STRIPE_SECRET_KEY#sk_test_}" != "$STRIPE_SECRET_KEY"
uv run pytest -m real_stripe -v
```

Do not weaken, skip, or mock PostgreSQL concurrency tests to make CI green.

## Definition of done

A billing behavior change is complete only when:

- its invariant is documented;
- a happy-path test exists;
- duplicate event and different-event/same-business-effect tests exist;
- relevant out-of-order permutations exist;
- at least one actual concurrent database test exists for a race-sensitive path;
- rollback/retry behavior remains proven;
- Ruff, Mypy, PostgreSQL tests, and `git diff --check` pass;
- TypeScript and Web gates pass when their runtime, shared policy, or UI contract changes;
- real Stripe object-shape tests pass when the change touches Stripe payload parsing.

## Commit style

Use Conventional Commits with imperative subjects no longer than 72 characters.
