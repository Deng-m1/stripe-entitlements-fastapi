-- Stripe Entitlements reference schema.
-- PostgreSQL is both the system of record and the distributed coordination layer.

create table if not exists billing_accounts (
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
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (plan_interval is null or plan_interval in ('month', 'year')),
  check (annual_grants_issued between 0 and 12),
  check (annual_grants_allowed between 0 and 12)
);

create table if not exists stripe_webhook_events (
  id text primary key,
  event_type text not null,
  livemode boolean not null,
  payload jsonb not null,
  outcome text,
  reason text,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);

create table if not exists stripe_invoice_state (
  invoice_id text primary key,
  account_id uuid references billing_accounts(id) on delete set null,
  amount_total bigint not null default 0,
  amount_refunded bigint not null default 0,
  fully_refunded boolean not null default false,
  disputed boolean not null default false,
  grant_units_per_slot bigint not null default 0,
  grants_issued smallint not null default 0,
  updated_at timestamptz not null default now(),
  check (amount_total >= 0),
  check (amount_refunded >= 0),
  check (amount_refunded <= amount_total or amount_total = 0),
  check (grants_issued between 0 and 12)
);

create table if not exists credit_ledger (
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

create unique index if not exists credit_ledger_invoice_slot_unique
  on credit_ledger(stripe_invoice_id, grant_slot)
  where stripe_invoice_id is not null and grant_slot is not null;

create index if not exists credit_ledger_account_created
  on credit_ledger(account_id, id desc);

create table if not exists credit_debits (
  idempotency_key text primary key,
  account_id uuid not null references billing_accounts(id) on delete cascade,
  amount bigint not null check (amount > 0),
  grant_epoch bigint not null,
  created_at timestamptz not null default now(),
  refunded_at timestamptz
);

create index if not exists credit_debits_account_created
  on credit_debits(account_id, created_at desc);

create table if not exists checkout_claims (
  account_id uuid primary key references billing_accounts(id) on delete cascade,
  claim_token uuid not null unique,
  session_id text unique,
  plan_key text not null,
  plan_interval text not null check (plan_interval in ('month', 'year')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists billing_incidents (
  id bigserial primary key,
  kind text not null,
  dedupe_key text not null,
  stripe_event_id text,
  invoice_id text,
  account_id uuid references billing_accounts(id) on delete set null,
  detail jsonb not null default '{}'::jsonb,
  seen_count integer not null default 1,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved_at timestamptz
);

create unique index if not exists billing_incidents_unresolved_unique
  on billing_incidents(kind, dedupe_key)
  where resolved_at is null;

create index if not exists billing_accounts_annual_due
  on billing_accounts(annual_anchor)
  where plan_interval = 'year' and subscription_status = 'active';
