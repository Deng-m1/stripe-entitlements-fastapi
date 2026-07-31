-- Authenticated billing API and server-controlled plan transition state.

alter table billing_accounts
  add column if not exists cancel_at_period_end boolean not null default false;

alter table billing_accounts
  add column if not exists pending_free_at timestamptz;

alter table billing_accounts
  add column if not exists entitlement_period_end timestamptz;

alter table billing_accounts
  add column if not exists credit_expires_at timestamptz;

alter table billing_accounts
  add column if not exists entitlement_revoked boolean not null default false;

alter table checkout_claims
  add column if not exists client_request_key text;

alter table checkout_claims
  add column if not exists session_url text;

create table if not exists billing_plan_changes (
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
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique(account_id, idempotency_key)
);

create unique index if not exists billing_plan_changes_one_pending
  on billing_plan_changes(account_id)
  where status in (
    'reserved', 'previewed', 'applying', 'scheduled', 'applied', 'requires_action'
  );

create index if not exists billing_plan_changes_account_created
  on billing_plan_changes(account_id, created_at desc);

create or replace function prevent_invoice_account_rebind()
returns trigger language plpgsql as $$
begin
  if old.account_id is not null and new.account_id is distinct from old.account_id then
    raise exception 'stripe_invoice_state.account_id is immutable once assigned';
  end if;
  return new;
end;
$$;

drop trigger if exists stripe_invoice_state_account_immutable on stripe_invoice_state;
create trigger stripe_invoice_state_account_immutable
before update of account_id on stripe_invoice_state
for each row execute function prevent_invoice_account_rebind();
