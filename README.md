# Stripe Entitlements for FastAPI

[![CI](https://github.com/FromCSUZhou/stripe-entitlements-fastapi/actions/workflows/ci.yml/badge.svg)](https://github.com/FromCSUZhou/stripe-entitlements-fastapi/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Python](https://img.shields.io/badge/python-3.12%2B-3776AB.svg)](pyproject.toml)

A PostgreSQL-backed reference implementation for race-safe Stripe subscriptions and
credit entitlements. It demonstrates idempotent webhook processing, ordered state
projection, invoice-attributed credit grants, refunds and disputes, annual plans that
grant monthly, Checkout single-flight, durable incidents, and replay-safe operations.

> This is an independent community project, not an official Stripe product. It is a
> reference implementation, not financial, tax, accounting, or legal advice.

## Why this exists

Most SaaS starters show how to create a Checkout Session and update one subscription
row. Production failures happen between those happy-path steps:

- Stripe retries the same event or delivers two events concurrently.
- Different event IDs describe the same invoice-side effect.
- `invoice.payment_failed` arrives after a newer successful payment.
- a refund or dispute arrives before `invoice.paid`.
- two requests create two simultaneously payable Checkout Sessions.
- a yearly subscription is paid once but product credits must be granted monthly.
- an unsafe Billing Portal proration policy charges less than the entitlement grant.

This repository makes those failure modes explicit and executable.

## Safety model

- **At-least-once delivery, effectively-once database effects.** It does not claim
  impossible end-to-end exactly-once delivery.
- `stripe_webhook_events.id` is the event-level inbox.
- `(stripe_invoice_id, grant_slot)` is the independent business-level idempotency key.
- account rows serialize entitlement state changes with `SELECT ... FOR UPDATE`.
- `(event.created, event_rank)` prevents older/weaker projections from rolling back
  newer state.
- refund state is persisted even when it arrives before the grant it affects.
- every fail-closed branch produces a durable `billing_incidents` record.

See [Invariants](docs/INVARIANTS.md) and [Architecture](docs/ARCHITECTURE.md).

## Single instance or distributed?

The API and annual grant worker are safe to run in multiple processes or machines
against the same PostgreSQL database. No correctness decision relies on process memory
or Redis. PostgreSQL is the coordination and truth layer, so the system is
**distributed-worker safe, but PostgreSQL remains a stateful dependency and potential
single point of failure** unless deployed with managed HA, backups, and tested restore.

See [Distributed deployment](docs/DISTRIBUTED.md) and [Operations](docs/OPERATIONS.md).

## Quick start

Requirements: Python 3.12+, `uv`, Docker, Stripe CLI, and a Stripe test-mode account.

```bash
cp .env.example .env
docker compose up -d postgres
uv sync
uv run stripe-entitlements migrate
uv run uvicorn stripe_entitlements.app:create_app --factory --port 8000
```

In a second terminal:

```bash
stripe login
stripe listen --forward-to http://127.0.0.1:8000/webhooks/stripe
```

Copy the printed `whsec_...` into `.env`, restart the API, then use a third terminal:

```bash
stripe trigger invoice.paid
```

The canned event has no matching local account, so a `paid_unknown_account` incident is
the expected result. The real lifecycle suite creates isolated test-mode Stripe objects
and matching local accounts; see [Stripe CLI](docs/STRIPE_CLI.md).

## Plan catalog and Stripe objects

Edit `plans.toml`, then create or verify the dedicated test-mode catalog:

```bash
STRIPE_SECRET_KEY=sk_test_... uv run python scripts/bootstrap_stripe.py
STRIPE_SECRET_KEY=sk_test_... uv run python scripts/bootstrap_stripe.py --verify-only
```

Test and live mode are separate Stripe object universes. Production must repeat both
commands with an `sk_live_...` key and must create a separate live webhook endpoint.
The script refuses keys that are not explicitly test or live secret keys.

## Test matrix

```bash
uv run ruff check .
uv run mypy src
uv run pytest -m "not real_stripe"
```

The normal suite starts an isolated PostgreSQL 17 Docker container and tests actual
transactions, constraints, row locks, rollback, concurrent delivery, event permutations,
refund convergence, annual worker concurrency, and Checkout claims.

Real Stripe test-mode verification is opt-in:

```bash
STRIPE_SECRET_KEY=sk_test_... \
  uv run pytest -m real_stripe -v
```

The real suite rejects live keys, prefixes every object as an automated test, and removes
the created customer and product in `finally` blocks. Full instructions and the tested
guarantee boundary are in [Testing](docs/TESTING.md).

## Repository map

- `src/stripe_entitlements/processor.py`: transactional webhook reducer.
- `src/stripe_entitlements/annual.py`: multi-worker-safe annual monthly grants.
- `src/stripe_entitlements/checkout.py`: Checkout single-flight coordinator.
- `src/stripe_entitlements/credits.py`: atomic usage charges and epoch-safe refunds.
- `src/stripe_entitlements/reconcile.py`: Stripe-truth repair after webhook loss.
- `src/stripe_entitlements/stripe_gateway.py`: signature verification and prefetch layer.
- `migrations/001_schema.sql`: complete PostgreSQL schema and constraints.
- `scripts/bootstrap_stripe.py`: idempotent catalog and Portal configuration.
- `tests/`: unit, PostgreSQL integration, race, API, and real Stripe tests.
- `AGENTS.md`: strict instructions for coding agents operating this repository.

## Non-goals

- tax calculation, revenue recognition, invoices as accounting records, or PCI scope;
- multi-currency, quantities/seats, mixed subscription items, trials, coupons, or metered
  billing in the initial reference implementation;
- replacing Stripe Billing, Lago, Autumn, OpenMeter, or an accounting system;
- hiding business-policy decisions behind a false “universal billing” abstraction.

## License

Apache-2.0. See [LICENSE](LICENSE).
