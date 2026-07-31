# Testing strategy

## Default suite

`pytest -m "not real_stripe"` starts a disposable PostgreSQL 17 container on a
workspace-derived loopback port, applies the real SQL migration, and removes the
container after the session. Each test truncates all tables.

Coverage categories:

- pure ordering, status, rounding, and catalog tests;
- raw webhook signature and API response tests;
- transaction rollback followed by successful retry;
- concurrent same-event delivery;
- different events attempting the same invoice grant;
- failed/paid/deleted event permutations, including same-second ties;
- partial and full refund before/after paid convergence;
- concurrent cumulative refund updates;
- Checkout reservation, attach, release, expiration, and stale terminal events;
- annual multi-worker grants, downtime slot jumps, plan mismatch, and refund reduction;
- incident deduplication and database constraint tests.

## Real Stripe suite

Tests marked `real_stripe` make network calls only when `STRIPE_SECRET_KEY` starts with
`sk_test_`. They create uniquely prefixed Product, Prices, Customer, and subscription
objects, verify current Stripe object shapes through the same gateway code, and clean up
objects created by that test run.

The real suite proves compatibility with the current Stripe test API. It does not prove
that arbitrary Dashboard configuration is safe, that Stripe will deliver within a fixed
time, or that production tax/accounting configuration is correct.

## Required commands before release

```bash
uv run ruff check .
uv run mypy src
uv run pytest -m "not real_stripe"
STRIPE_SECRET_KEY=sk_test_... uv run pytest -m real_stripe -v
git diff --check
```

Record the date, Stripe API version, counts, and any skipped scenario in the release notes.

## Latest verified baseline

On 2026-07-31 the project was verified against PostgreSQL 17, stripe-python 15.4.0,
Stripe API `2026-06-24.dahlia`, a real test-mode subscription and half refund, a real
Test Clock advance, and Stripe CLI local forwarding. The real API run also verified the
Basil/Dahlia `payment_intent -> InvoicePayment -> invoice` fallback for refunded Charges
that omit a direct invoice field.
