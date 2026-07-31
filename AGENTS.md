# Agent Operating Guide

This repository is billing infrastructure. Optimize for explicit invariants and
reproducible evidence, not short diffs.

## Required reading

Before changing behavior, read these files completely:

1. `docs/INVARIANTS.md`
2. `docs/ARCHITECTURE.md`
3. `docs/DISTRIBUTED.md`
4. `docs/TESTING.md`
5. `docs/STRIPE_CLI.md` when touching Stripe API or CLI behavior

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

```bash
uv sync
uv run ruff check .
uv run mypy src
uv run pytest -m "not real_stripe"
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
- real Stripe object-shape tests pass when the change touches Stripe payload parsing.

## Commit style

Use Conventional Commits with imperative subjects no longer than 72 characters.
