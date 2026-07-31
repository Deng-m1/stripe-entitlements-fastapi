# Plan transition policy

This document describes the six paid plan/interval states implemented by the
reference. It is a product policy, not a claim that the same matrix is correct
for every Stripe integration.

## State identity

Plan identity comes from `plans.toml`:

- rank: Starter 10, Pro 20, Ultra 30;
- interval: `month` or `year`;
- price amounts are not used to decide upgrade/downgrade direction.

The six states are `SM`, `SY`, `PM`, `PY`, `UM` and `UY`.

## 6 × 6 matrix

| From / To | SM | SY | PM | PY | UM | UY |
| --- | --- | --- | --- | --- | --- | --- |
| **SM** | noop | immediate | immediate | immediate | immediate | immediate |
| **SY** | period end | noop | period end | period end | period end | period end |
| **PM** | period end | period end | noop | immediate | immediate | immediate |
| **PY** | period end | period end | period end | noop | period end | period end |
| **UM** | period end | period end | period end | period end | noop | immediate |
| **UY** | period end | period end | period end | period end | period end | noop |

Decision order:

1. unchanged plan/interval is noop;
2. every other annual-origin transition is period-end;
3. from a monthly plan, a higher target rank is preview-eligible for immediate
   settlement;
4. a lower target rank is period-end;
5. same-tier `month → year` is preview-eligible for immediate settlement.

## Why every annual-origin change waits

A yearly invoice funds up to 12 monthly entitlement slots. Replacing it before
that lineage ends can use a negative proration from the old annual invoice to
fund a new monthly or annual invoice. If the old charge is later refunded or
disputed, a one-invoice funding model cannot safely attribute the loss to the
new entitlement epoch.

This rule applies before tier rank. Therefore `SY → PM`, `SY → PY`, `SY → UY`,
`PY → UM` and `PY → UY` are period-end even when their target rank is higher.

A 2026-07-31 manual test-mode `PY → UM` preview produced negative $204. That
observation motivated the conservative rule but is not an automated universal
price theorem; timing and account state can produce other amounts.

## Immediate means “preview-eligible”

The matrix does not directly mutate a Subscription. Preview:

1. creates a durable `billing_plan_changes` intent bound to account, target and
   `Idempotency-Key`;
2. snapshots the current grant epoch, entitlement end, cancellation state and
   Stripe subscription identity;
3. retrieves the Stripe Subscription and target Price outside a database
   transaction;
4. revalidates the snapshot;
5. requests a full-new-period invoice preview with
   `billing_cycle_anchor=now` and `proration_behavior=none`.

An immediate cell remains immediate only when the preview has:

- exactly one quantity-1, non-proration target line;
- target line, invoice total and amount due equal the catalog price/currency;
- no nonzero positive or negative proration from another invoice;
- no Stripe customer-balance credit at either preview boundary.

Otherwise the coordinator stores a period-end decision and reports no amount due
today. Preview is server-authoritative; the browser must not reconstruct timing
from rank or price. Supporting discounted, taxed, credited or cross-invoice
immediate changes requires extending the funding-lineage model first.

## Confirm and payment recovery

Confirm accepts the opaque `preview_id`. It does not accept a fresh target and
cannot confirm another account's preview.

Immediate settlement uses:

- `billing_cycle_anchor=now`;
- `proration_behavior=none`;
- `payment_behavior=pending_if_incomplete`;
- a stable Stripe idempotency key.

This policy deliberately does not credit the unused monthly period. The target
starts a new, independently funded full-price period. A real test-mode Starter
Monthly → Pro Monthly run used Dahlia for outbound preview/update requests, then
polled the separately versioned paid Event and verified the 1,000-credit
PostgreSQL projection.

A successful API call is not entitlement proof. If payment is incomplete,
Stripe can retain the old Subscription item and active state while exposing a
pending update and open Invoice. The API returns a hosted payment URL when
available and an in-memory confirmation secret as an optional enhancement.
Neither value is stored in browser storage or logs.

The old entitlement remains active until a matching paid invoice webhook
completes the durable intent. A declined manual test-mode run on 2026-07-31
observed exactly this old-SKU/pending-update/open-Invoice state. That scenario is
documented evidence, not part of the automated `real_stripe` suite.

## Period-end schedules

Period-end changes use two Stripe operations:

1. create a Subscription Schedule with only `from_subscription`;
2. modify it with the preserved current phase and one target phase.

Stripe rejects extra phase/configuration fields during the first operation. The
second operation copies allowed tax, collection, payment, transfer and metadata
fields from the returned current phase, sets a contiguous boundary, disables
proration, and sets `end_behavior=release`.

Both calls have distinct derived idempotency keys. A real test-mode Starter
Yearly → Pro Yearly run used outbound Dahlia requests and verified the two-step
request plus contiguous phases; unit tests assert the exact preserved phase
payload. It is not described as a Test Clock lifecycle test.

## Webhook completion and stale events

`invoice.paid` for a subscription update activates a new plan only when it
matches a durable plan-change intent and expected entitlement snapshot. A
Dashboard price change without intent fails closed into an incident.

`invoice.payment_failed` for an optional upgrade marks the intent
`requires_action` but does not freeze the old paid entitlement. Schedule and
pending-update state is cleared/completed only by matching webhook facts.

The frontend success page polls `GET /api/account` for the target active
projection. Checkout return, hosted-invoice return, Stripe.js completion and the
confirm response are never used as direct access grants.
