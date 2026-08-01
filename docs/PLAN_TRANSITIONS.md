# Plan transition policies

The reference ships two complete, selectable policies. Set exactly one per deployment:

```dotenv
BILLING_TRANSITION_POLICY=full_period_reset
# or
BILLING_TRANSITION_POLICY=prorated_delta
```

The selected policy is returned by health, catalog, account, preview, and confirm APIs.
It is also copied into every durable `billing_plan_changes` row, so changing an
environment variable cannot reinterpret an in-flight intent.

Plan direction comes from the unique positive rank in `plans.toml`, never from price.
The six states are Starter Monthly/Yearly (`SM`, `SY`), Pro Monthly/Yearly (`PM`,
`PY`), and Ultra Monthly/Yearly (`UM`, `UY`).

## Template 1: full-period reset

This policy starts a newly funded target period for immediate changes. It does not
credit unused time.

| From / To | SM | SY | PM | PY | UM | UY |
| --- | --- | --- | --- | --- | --- | --- |
| **SM** | noop | immediate | immediate | immediate | immediate | immediate |
| **SY** | period end | noop | period end | period end | period end | period end |
| **PM** | period end | period end | noop | immediate | immediate | immediate |
| **PY** | period end | period end | period end | noop | period end | period end |
| **UM** | period end | period end | period end | period end | noop | immediate |
| **UY** | period end | period end | period end | period end | period end | noop |

An immediate preview/apply pair uses:

```text
billing_cycle_anchor=now
proration_behavior=none
payment_behavior=pending_if_incomplete
```

The preview remains immediate only when it contains one quantity-one target line at
the complete catalog price, matching currency and amount due, with no nonzero
proration, customer-balance credit, discount, credit note, or tax. Otherwise it is
stored and presented as period-end. The later paid Invoice independently has to satisfy
the same one-line catalog amount, currency, quantity, full-payment, and unsupported-
adjustment contract; preview acceptance alone is not authority. A paid Invoice resets
the active credit pool to the target plan's monthly grant and advances `grant_epoch`.

## Template 2: prorated entitlement delta

This policy supports the common same-period monthly tier upgrade: Stripe credits the
unused source tier, charges the target tier for the same remaining time, and the
application adds the fixed entitlement difference.

| From / To | SM | SY | PM | PY | UM | UY |
| --- | --- | --- | --- | --- | --- | --- |
| **SM** | noop | period end | immediate delta | period end | immediate delta | period end |
| **SY** | period end | noop | period end | period end | period end | period end |
| **PM** | period end | period end | noop | period end | immediate delta | period end |
| **PY** | period end | period end | period end | noop | period end | period end |
| **UM** | period end | period end | period end | period end | noop | period end |
| **UY** | period end | period end | period end | period end | period end | noop |

All 36 cells are deliberate. Immediate delta is bounded to a higher-rank monthly plan
while retaining the monthly interval. Downgrades, month/year conversions, and every
annual-origin change wait until period end. This avoids claiming that a two-line
monthly proration reducer also solves annual multi-slot funding.

Preview fixes one `proration_date`; confirm reuses that exact value:

```text
proration_behavior=always_invoice
proration_date=<durable preview value>
payment_behavior=pending_if_incomplete
```

The billing anchor is not reset. A successful paid Invoice keeps the existing
entitlement period and `grant_epoch`, preserves the currently unused balance, and
adds:

```text
target.monthly_credits - source.monthly_credits
```

For example, Starter (300) to Pro (1,000) adds exactly 700 credits. It does not turn
the cash amount into credits. Remaining time, rounding, coupons, balance, and tax
therefore cannot silently change the product entitlement.

## Authoritative Invoice shape for delta upgrades

The webhook preparation layer materializes every Invoice line page before opening a
database transaction and resolves both legacy `line.price` and Dahlia
`pricing.price_details.price` references. A delta Invoice is accepted only when:

- it matches one authenticated, durable immediate `prorated_delta` intent;
- exactly two quantity-one proration lines exist;
- one negative line is the intent's source catalog Price;
- one positive line is the intent's target catalog Price;
- source and target periods and currencies match;
- both line periods start at the persisted `proration_date` and end at the existing
  entitlement boundary;
- source and target cash prorations represent the same remaining-period fraction,
  within one-cent rounding tolerance;
- line sum, subtotal, total, amount due, and amount paid prove a positive fully paid
  net difference;
- no additional, unknown, zero-target, tax, discount, credit-note, or customer-balance
  funding participates.

Missing pages, unknown Price references, duplicated/conflicting source or target
lines, a stale Subscription, and unsupported adjustments create a durable incident
and leave the old entitlement unchanged. Subscription state is used for identity and
eventual observation; it is never used to guess what an Invoice funded.

Preview persists the exact source credit, target charge, positive net due, currency,
and service-period boundaries. The paid Invoice must match every one of those facts;
matching only a Price ID or final total is insufficient. An unconfirmed `previewed`
intent cannot authorize this paid effect.

## Funding allocation and refund semantics

`billing_funding_allocations` links every accepted delta Invoice to:

- the immutable source funding Invoice;
- source/target plans, Price line IDs, and service period;
- source credit, target charge, net cash, and fixed entitlement delta;
- the unchanged `grant_epoch` and cumulative refund/dispute state.

This produces these explicit outcomes:

| Event | Current-epoch result |
| --- | --- |
| Partial refund of delta Invoice | remove the rounded-up proportional share of only the added delta; retain target plan |
| Full refund/dispute of latest leaf delta | remove its delta, advance the product-refund epoch, and revert locally to its still-funded source plan |
| Full refund/dispute of an intermediate delta with downstream upgrades | remove its delta, revoke enforcement, and create `funding_lineage_closed` |
| Partial refund of source Invoice | remove the proportional share of source credits; retain target plan |
| Full refund/dispute of source Invoice used by a delta | claw back source units, revoke enforcement, and create a lineage incident |
| Refund of an Invoice from an older `grant_epoch` | retain the historical fact but do not rewrite the current pool |

Refund/dispute state is stored even when it arrives before `invoice.paid`. Paid-first
and clawback-first permutations converge. A fully closed upgrade Invoice received
before its paid Event creates a zero-effect business guard, fails the intent, and
keeps the source entitlement. Product operators must resolve the remote Subscription
if Stripe still points at a target Price after a local funding reversion; the incident
is intentional rather than silently trusting mutable Subscription state.

`stripe_invoice_state.closure_applied` separately guards terminal closure. Distinct
refund/dispute Event IDs cannot repeat a refund-before-paid block, leaf reversion,
lineage revocation, annual closure, epoch advance, or debt creation for one Invoice.

The leaf-reversion epoch advance prevents a late product-job refund from recreating
credits that the closed upgrade Invoice had funded. The closed allocation remains an
active ancestry edge so a later source-Invoice refund is still attributed correctly.

Spending can make the current balance smaller than a required current-epoch clawback.
In that case the processor removes everything available and persists the missing units
in `billing_clawback_debts`. A later usage refund or delta grant in the same epoch is
first written to the audit ledger and then consumed against outstanding debt in stable
order. Debt from a historical epoch does not debit the current pool.

## Period-end changes and annual plans

Both policies use the same two-step Subscription Schedule operation for period-end
changes: create from the current Subscription, then configure a preserved current
phase and contiguous target phase with `proration_behavior=none` and
`end_behavior=release`. Create and configure use separate derived idempotency keys. A
retry after a create-only crash recovers that Schedule, while an already configured
Schedule is accepted only after Subscription identity, both Price/quantity phases,
boundary, no-proration policy, release behavior, product line, and plan-change identity
all match.

A yearly paid Invoice funds up to 12 monthly entitlement slots. It remains one annual
funding lineage until its period ends. The delta template deliberately does not split
or replace those slots mid-year. Yearly renewal still resets to slot 1 under the new
paid Invoice, and the annual worker grants only the current due slot after downtime.

## Failure, order, and idempotency

- Event ID is delivery idempotency; `(stripe_invoice_id, grant_slot)` is independent
  business idempotency.
- Confirm atomically changes `previewed` to `applying`, then records
  `remote_started_at` before the first Stripe mutation. A webhook may authorize the
  target only from `applying`, `applied`, `requires_action`, or the matching period-end
  `scheduled` state—never from an unconfirmed preview.
- An unknown result younger than 23 hours is replayed only with the same derived Stripe
  idempotency key. At 23 hours, automatic mutation stops; an operator must prove the
  exact Invoice or Schedule outcome before repairing state.
- Account locking precedes Invoice/allocation locking on paid, refund, dispute,
  reconciliation, and annual paths.
- A different Event ID for the same Invoice can race, but only one grant commits.
- `subscription.updated` before or after `invoice.paid` cannot issue credits.
- Payment failure or SCA keeps the source paid entitlement and marks the intent
  `requires_action` only when the Event's Invoice exactly matches the intent's
  compare-and-set `settlement_invoice_id`. An unbound or delayed older failure creates
  an incident and cannot change the new intent.
- The paid webhook may finish before the coordinator persists its remote result. Both
  paths may bind only the same settlement Invoice; confirm reports a conflict if the
  webhook already failed the intent and never turns POST success into entitlement proof.
- A processing exception rolls back the Event claim, allocation, ledger, account, and
  intent together; retrying the same Event can complete normally.
- Browser return, confirm success, and hosted-invoice completion never grant access.

The frontend renders `settlement_mode` from the server:

- `new_period_full_price`;
- `current_period_prorated_delta`;
- `period_end`.

It never reconstructs policy from rank or displayed price.
