-- Stripe Entitlements 0.3 baseline.
--
-- PostgreSQL is both the system of record and the distributed coordination layer.
-- This fresh-install baseline intentionally replaces the pre-0.3 migration lineage.

create table billing_accounts (
  id uuid primary key,
  external_ref text not null unique,
  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  plan_key text not null default 'free',
  plan_interval text,
  subscription_status text not null default 'none'
    check (subscription_status in ('none', 'active', 'past_due', 'canceled')),
  credits_balance bigint not null default 0 check (credits_balance >= 0),
  grant_epoch bigint not null default 0,
  event_created bigint not null default 0,
  event_rank smallint not null default 0,
  current_period_end timestamptz,
  annual_anchor timestamptz,
  annual_grants_issued smallint not null default 0,
  annual_grants_allowed smallint not null default 12,
  funding_invoice_id text,
  cancel_at_period_end boolean not null default false,
  pending_free_at timestamptz,
  entitlement_period_end timestamptz,
  credit_expires_at timestamptz,
  entitlement_revoked boolean not null default false,
  last_reconciled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (plan_interval is null or plan_interval in ('month', 'year')),
  check (annual_grants_issued between 0 and 12),
  check (annual_grants_allowed between 0 and 12)
);

comment on column billing_accounts.credits_balance is
  'Product-credit atoms. One displayed credit is exactly 1000000 atoms.';

create index billing_accounts_annual_due
  on billing_accounts(annual_anchor)
  where plan_interval = 'year' and subscription_status = 'active';

create index billing_accounts_reconcile_rotation
  on billing_accounts(last_reconciled_at nulls first, id)
  where stripe_subscription_id is not null;

create table stripe_webhook_events (
  id text primary key,
  event_type text not null,
  livemode boolean not null,
  payload jsonb not null,
  outcome text,
  reason text,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);

comment on column stripe_webhook_events.payload is
  'Redacted audit snapshot; not the exact signed request body.';

create table stripe_invoice_state (
  invoice_id text primary key,
  account_id uuid references billing_accounts(id) on delete restrict,
  amount_total bigint not null default 0,
  amount_refunded bigint not null default 0,
  fully_refunded boolean not null default false,
  disputed boolean not null default false,
  grant_units_per_slot bigint not null default 0,
  grants_issued smallint not null default 0,
  closure_applied boolean not null default false,
  updated_at timestamptz not null default now(),
  check (amount_total >= 0),
  check (amount_refunded >= 0),
  check (amount_refunded <= amount_total or amount_total = 0),
  check (grants_issued between 0 and 12)
);

comment on column stripe_invoice_state.grant_units_per_slot is
  'Product-credit atoms per funded subscription slot; never Stripe currency units.';

create function prevent_invoice_account_rebind()
returns trigger language plpgsql as $$
begin
  if old.account_id is not null and new.account_id is distinct from old.account_id then
    raise exception 'stripe_invoice_state.account_id is immutable once assigned';
  end if;
  return new;
end;
$$;

create trigger stripe_invoice_state_account_immutable
before update of account_id on stripe_invoice_state
for each row execute function prevent_invoice_account_rebind();

create table credit_ledger (
  id bigserial primary key,
  account_id uuid not null references billing_accounts(id) on delete cascade,
  delta bigint not null,
  balance_after bigint not null check (balance_after >= 0),
  entitlement_units bigint not null default 0 check (entitlement_units >= 0),
  reason text not null,
  grant_epoch bigint not null,
  stripe_event_id text,
  stripe_invoice_id text,
  grant_slot smallint,
  created_at timestamptz not null default now(),
  check (grant_slot is null or grant_slot between 1 and 12)
);

comment on column credit_ledger.delta is
  'Signed product-credit atoms applied by this ledger entry.';
comment on column credit_ledger.balance_after is
  'Product-credit atoms remaining after this ledger entry.';
comment on column credit_ledger.entitlement_units is
  'Product-credit atoms attributed to the funding source.';

create unique index credit_ledger_invoice_slot_unique
  on credit_ledger(stripe_invoice_id, grant_slot)
  where stripe_invoice_id is not null and grant_slot is not null;

create index credit_ledger_account_created
  on credit_ledger(account_id, id desc);

create table credit_debits (
  idempotency_key text primary key,
  account_id uuid not null references billing_accounts(id) on delete cascade,
  amount bigint not null check (amount > 0),
  grant_epoch bigint not null,
  created_at timestamptz not null default now(),
  refunded_at timestamptz
);

comment on column credit_debits.amount is
  'Product-credit atoms charged under the idempotency key.';

create index credit_debits_account_created
  on credit_debits(account_id, created_at desc);

create table checkout_claims (
  account_id uuid primary key references billing_accounts(id) on delete cascade,
  claim_token uuid not null unique,
  session_id text unique,
  plan_key text not null,
  plan_interval text not null check (plan_interval in ('month', 'year')),
  expires_at timestamptz not null,
  client_request_key text,
  session_url text,
  created_at timestamptz not null default now()
);

create table billing_incidents (
  id bigserial primary key,
  kind text not null,
  dedupe_key text not null,
  stripe_event_id text,
  invoice_id text,
  account_id uuid references billing_accounts(id) on delete set null,
  detail jsonb not null default '{}'::jsonb,
  seen_count integer not null default 1,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default clock_timestamp(),
  resolved_at timestamptz
);

create unique index billing_incidents_unresolved_unique
  on billing_incidents(kind, dedupe_key)
  where resolved_at is null;

create index billing_incidents_unresolved_account_kind_seen
  on billing_incidents(account_id, kind, last_seen_at, id)
  where resolved_at is null;

create table billing_plan_changes (
  id uuid primary key,
  account_id uuid not null references billing_accounts(id) on delete cascade,
  idempotency_key text not null,
  stripe_subscription_id text not null,
  from_plan_key text not null,
  from_interval text not null check (from_interval in ('month', 'year')),
  target_plan_key text not null,
  target_interval text not null check (target_interval in ('month', 'year')),
  effective_mode text not null check (effective_mode in ('immediate', 'period_end', 'noop')),
  status text not null check (
    status in (
      'reserved', 'previewed', 'applying', 'scheduled', 'applied',
      'requires_action', 'completed', 'failed'
    )
  ),
  effective_at timestamptz,
  stripe_schedule_id text unique,
  stripe_request_key text not null unique,
  expected_grant_epoch bigint not null,
  expected_entitlement_period_end timestamptz,
  expected_subscription_status text not null,
  expected_cancel_at_period_end boolean not null,
  proration_date bigint,
  estimated_amount_due bigint,
  estimated_credit_applied bigint,
  estimated_customer_balance_credit bigint,
  estimate_currency text,
  preview_expires_at timestamptz,
  lease_token uuid,
  lease_expires_at timestamptz,
  remote_pending_expires_at timestamptz,
  recovery_url text,
  last_error text,
  transition_policy text not null default 'full_period_reset'
    check (transition_policy in ('full_period_reset', 'prorated_delta')),
  expected_source_invoice_id text,
  expected_credit_delta bigint
    check (expected_credit_delta is null or expected_credit_delta > 0),
  expected_entitlement_revoked boolean not null default false,
  settlement_invoice_id text,
  remote_started_at timestamptz,
  estimated_source_proration bigint,
  estimated_target_proration bigint,
  estimated_period_start timestamptz,
  estimated_period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique(account_id, idempotency_key)
);

comment on column billing_plan_changes.expected_credit_delta is
  'Authorized product-credit atoms; unrelated to Stripe cash credits.';

create unique index billing_plan_changes_one_pending
  on billing_plan_changes(account_id)
  where status in (
    'reserved', 'previewed', 'applying', 'scheduled', 'applied', 'requires_action'
  );

create index billing_plan_changes_account_created
  on billing_plan_changes(account_id, created_at desc);

create unique index billing_plan_changes_settlement_invoice_unique
  on billing_plan_changes(settlement_invoice_id)
  where settlement_invoice_id is not null;

create table billing_funding_allocations (
  id bigserial primary key,
  account_id uuid not null references billing_accounts(id) on delete cascade,
  plan_change_id uuid not null unique
    references billing_plan_changes(id) on delete restrict,
  stripe_invoice_id text not null unique,
  source_invoice_id text not null,
  stripe_event_id text not null,
  transition_policy text not null
    check (transition_policy = 'prorated_delta'),
  source_plan_key text not null,
  source_interval text not null check (source_interval in ('month', 'year')),
  target_plan_key text not null,
  target_interval text not null check (target_interval in ('month', 'year')),
  source_line_id text not null,
  target_line_id text not null,
  entitlement_delta bigint not null check (entitlement_delta > 0),
  refunded_units bigint not null default 0,
  source_credit_amount bigint not null check (source_credit_amount > 0),
  target_charge_amount bigint not null check (target_charge_amount > 0),
  amount_paid bigint not null check (amount_paid > 0),
  currency text not null,
  period_start timestamptz not null,
  period_end timestamptz not null,
  grant_epoch bigint not null,
  status text not null default 'active'
    check (status in ('active', 'partially_refunded', 'closed', 'disputed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (source_line_id <> target_line_id),
  check (source_plan_key <> target_plan_key),
  check (source_interval = 'month' and target_interval = 'month'),
  check (target_charge_amount > source_credit_amount),
  check (amount_paid = target_charge_amount - source_credit_amount),
  check (refunded_units between 0 and entitlement_delta),
  check (period_end > period_start)
);

comment on column billing_funding_allocations.entitlement_delta is
  'Product-credit atoms granted by this upgrade funding allocation.';
comment on column billing_funding_allocations.refunded_units is
  'Cumulative product-credit atoms withdrawn from the entitlement delta.';
comment on column billing_funding_allocations.source_credit_amount is
  'Stripe currency minor units credited for the source proration; not product credits.';

create index billing_funding_allocations_account_epoch
  on billing_funding_allocations(account_id, grant_epoch, id desc);

create index billing_funding_allocations_source_invoice
  on billing_funding_allocations(source_invoice_id);

create table billing_clawback_debts (
  account_id uuid not null references billing_accounts(id) on delete cascade,
  grant_epoch bigint not null,
  stripe_invoice_id text not null references stripe_invoice_state(invoice_id)
    on delete restrict,
  target_units bigint not null check (target_units > 0),
  collected_units bigint not null default 0 check (collected_units >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(account_id, grant_epoch, stripe_invoice_id),
  check (collected_units <= target_units)
);

comment on column billing_clawback_debts.target_units is
  'Product-credit atoms that must be withdrawn for this funding source.';
comment on column billing_clawback_debts.collected_units is
  'Product-credit atoms already withdrawn toward target_units.';

create index billing_clawback_debts_outstanding
  on billing_clawback_debts(account_id, grant_epoch, created_at)
  where collected_units < target_units;
