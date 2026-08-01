-- Two explicit settlement policies and cross-invoice entitlement attribution.

alter table billing_plan_changes
  add column if not exists transition_policy text not null default 'full_period_reset'
    check (transition_policy in ('full_period_reset', 'prorated_delta'));

alter table billing_plan_changes
  add column if not exists expected_source_invoice_id text;

alter table billing_plan_changes
  add column if not exists expected_credit_delta bigint
    check (expected_credit_delta is null or expected_credit_delta > 0);

alter table billing_plan_changes
  add column if not exists expected_entitlement_revoked boolean not null default false;

alter table billing_plan_changes
  add column if not exists settlement_invoice_id text;

alter table billing_plan_changes
  add column if not exists remote_started_at timestamptz;

alter table billing_plan_changes
  add column if not exists estimated_source_proration bigint;

alter table billing_plan_changes
  add column if not exists estimated_target_proration bigint;

alter table billing_plan_changes
  add column if not exists estimated_period_start timestamptz;

alter table billing_plan_changes
  add column if not exists estimated_period_end timestamptz;

alter table billing_accounts
  add column if not exists last_reconciled_at timestamptz;

alter table stripe_invoice_state
  add column if not exists closure_applied boolean not null default false;

-- A closed Invoice and its grant/effects committed in one transaction before this
-- column existed. Backfill only rows with a durable grant marker; refund-before-paid
-- rows have no grant yet and must remain false so the later paid path can block them.
update stripe_invoice_state s
   set closure_applied=true
 where exists (
     select 1 from credit_ledger l
      where l.stripe_invoice_id=s.invoice_id
        and l.grant_slot is not null
        and (
          s.fully_refunded or s.disputed
          or l.reason in ('subscription_grant_blocked','upgrade_delta_blocked')
        )
   );

create index if not exists billing_accounts_reconcile_rotation
  on billing_accounts(last_reconciled_at nulls first, id)
  where stripe_subscription_id is not null;

create unique index if not exists billing_plan_changes_settlement_invoice_unique
  on billing_plan_changes(settlement_invoice_id)
  where settlement_invoice_id is not null;

create table if not exists billing_funding_allocations (
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

create index if not exists billing_funding_allocations_account_epoch
  on billing_funding_allocations(account_id, grant_epoch, id desc);

create index if not exists billing_funding_allocations_source_invoice
  on billing_funding_allocations(source_invoice_id);

create table if not exists billing_clawback_debts (
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

create index if not exists billing_clawback_debts_outstanding
  on billing_clawback_debts(account_id, grant_epoch, created_at)
  where collected_units < target_units;
