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
  'Minimal allowlisted operational audit snapshot; never the exact signed request body.';

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
  kind text not null default 'usage'
    check (kind in ('usage', 'credit_pack_debt_collection')),
  clawback_order_id uuid,
  restored_credits bigint not null default 0 check (restored_credits >= 0),
  created_at timestamptz not null default now(),
  refunded_at timestamptz,
  check (restored_credits <= amount),
  check ((kind = 'usage') = (clawback_order_id is null))
);

comment on column credit_debits.amount is
  'Product-credit atoms charged under the idempotency key.';
comment on column credit_debits.restored_credits is
  'Product-credit atoms actually returned to still-valid sources by the terminal refund.';

create index credit_debits_account_created
  on credit_debits(account_id, created_at desc);

alter table credit_debits
  add constraint credit_debits_id_account_unique
  unique(idempotency_key,account_id);

create table credit_pack_orders (
  id uuid primary key,
  account_id uuid not null references billing_accounts(id) on delete restrict,
  client_idempotency_key text not null,
  stripe_request_key text not null unique,
  pack_key text not null,
  pack_credits bigint not null check (pack_credits > 0),
  price_amount bigint not null check (price_amount > 0),
  currency text not null check (currency = lower(currency) and length(currency) = 3),
  expires_days integer not null check (expires_days between 1 and 3650),
  price_lookup_key text not null
    check (length(price_lookup_key) between 1 and 255),
  request_customer_id text,
  checkout_status text not null default 'reserved'
    check (checkout_status in ('reserved', 'session_created', 'completed', 'expired')),
  payment_status text not null default 'pending'
    check (payment_status in ('pending', 'paid', 'partially_refunded', 'refunded', 'disputed')),
  stripe_checkout_session_id text unique,
  stripe_payment_intent_id text unique,
  stripe_charge_id text unique,
  stripe_customer_id text,
  session_url text,
  claim_expires_at timestamptz not null,
  reconcile_claim_token uuid,
  reconcile_claim_expires_at timestamptz,
  last_reconciled_at timestamptz,
  last_reconcile_error text
    check (last_reconcile_error is null or length(last_reconcile_error) between 1 and 255),
  amount_paid bigint check (amount_paid is null or amount_paid > 0),
  amount_refunded bigint not null default 0 check (amount_refunded >= 0),
  refunded_credits bigint not null default 0 check (refunded_credits >= 0),
  paid_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique(account_id, client_idempotency_key),
  unique(id, account_id),
  check (refunded_credits <= pack_credits),
  check (amount_paid is null or amount_refunded <= amount_paid),
  check (amount_paid is null or amount_paid = price_amount),
  check ((payment_status = 'pending') = (amount_paid is null)),
  check (
    (payment_status in ('pending','paid') and amount_refunded = 0
                                          and refunded_credits = 0)
    or (payment_status = 'partially_refunded' and amount_refunded > 0
                                                and amount_refunded < amount_paid
                                                and refunded_credits > 0
                                                and refunded_credits <= pack_credits)
    or (payment_status in ('refunded','disputed') and amount_refunded > 0
                                                    and amount_refunded = amount_paid
                                                    and refunded_credits = pack_credits)
  ),
  check (stripe_checkout_session_id is not null or checkout_status = 'reserved'),
  check (stripe_payment_intent_id is not null or payment_status = 'pending'),
  check ((reconcile_claim_token is null) = (reconcile_claim_expires_at is null))
);

comment on column credit_pack_orders.pack_credits is
  'Immutable product-credit atom snapshot reserved before remote Checkout creation.';
comment on column credit_pack_orders.price_amount is
  'Stripe currency minor units; never product-credit atoms.';
comment on column credit_pack_orders.request_customer_id is
  'Immutable Checkout request customer. NULL means customer_creation=always without an email prefill.';
comment on column credit_pack_orders.paid_at is
  'Immutable first committed Stripe payment-fact time; duplicate, refund, and dispute facts do not rewrite it.';

create index credit_pack_orders_account_created
  on credit_pack_orders(account_id, created_at desc);
create index credit_pack_orders_expired_claims
  on credit_pack_orders(claim_expires_at, id)
  where checkout_status in ('reserved', 'session_created') and payment_status = 'pending';
create index credit_pack_orders_reconcile_due
  on credit_pack_orders(last_reconciled_at nulls first, reconcile_claim_expires_at, id)
  where payment_status in ('pending', 'paid', 'partially_refunded', 'refunded', 'disputed');

create table credit_funding_lots (
  id uuid primary key,
  order_id uuid not null unique,
  account_id uuid not null references billing_accounts(id) on delete restrict,
  original_credits bigint not null check (original_credits > 0),
  remaining_credits bigint not null check (remaining_credits >= 0),
  expired_credits bigint not null default 0 check (expired_credits >= 0),
  cash_clawed_back_credits bigint not null default 0
    check (cash_clawed_back_credits >= 0),
  expires_at timestamptz not null,
  status text not null default 'active'
    check (status in ('active', 'expired', 'refunded', 'disputed')),
  closed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique(id,account_id),
  constraint credit_funding_lots_order_account_fk foreign key(order_id,account_id)
    references credit_pack_orders(id,account_id) on delete restrict,
  check (remaining_credits <= original_credits),
  check (expired_credits <= original_credits),
  check (cash_clawed_back_credits <= original_credits),
  check (remaining_credits + expired_credits + cash_clawed_back_credits
         <= original_credits),
  check ((status = 'active') = (closed_at is null)),
  check (status = 'active' or remaining_credits = 0)
);

comment on column credit_funding_lots.remaining_credits is
  'Unconsumed, unexpired product-credit atoms from exactly one paid pack order.';
comment on column credit_funding_lots.expired_credits is
  'Unconsumed atoms retired by lazy expiry and still available to satisfy later cash clawback.';
comment on column credit_funding_lots.cash_clawed_back_credits is
  'Unconsumed or expired atoms retired by cumulative Stripe cash refund or dispute facts.';
comment on column credit_funding_lots.expires_at is
  'Financial expiry derived once from order paid_at plus the snapshotted expiry policy.';
comment on column credit_funding_lots.created_at is
  'Local PostgreSQL projection time, not the Stripe payment or financial-expiry origin.';

create index credit_funding_lots_spendable
  on credit_funding_lots(account_id, expires_at, id)
  where status = 'active' and remaining_credits > 0;

create table credit_debit_allocations (
  id bigserial primary key,
  debit_idempotency_key text not null,
  account_id uuid not null references billing_accounts(id) on delete restrict,
  source_type text not null check (source_type in ('subscription', 'credit_pack')),
  subscription_grant_epoch bigint,
  funding_lot_id uuid,
  amount bigint not null check (amount > 0),
  refunded_amount bigint not null default 0 check (refunded_amount >= 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint credit_debit_allocations_debit_account_fk
    foreign key(debit_idempotency_key,account_id)
    references credit_debits(idempotency_key,account_id) on delete restrict,
  constraint credit_debit_allocations_lot_account_fk
    foreign key(funding_lot_id,account_id)
    references credit_funding_lots(id,account_id) on delete restrict,
  check (refunded_amount <= amount),
  check (
    (source_type = 'subscription' and subscription_grant_epoch is not null
                                  and funding_lot_id is null)
    or
    (source_type = 'credit_pack' and subscription_grant_epoch is null
                                  and funding_lot_id is not null)
  )
);

comment on column credit_debit_allocations.amount is
  'Exact product-credit atoms consumed from this funding source by one debit.';

create unique index credit_debit_allocations_subscription_unique
  on credit_debit_allocations(debit_idempotency_key, subscription_grant_epoch)
  where source_type = 'subscription';
create unique index credit_debit_allocations_pack_unique
  on credit_debit_allocations(debit_idempotency_key, funding_lot_id)
  where source_type = 'credit_pack';
create index credit_debit_allocations_lot
  on credit_debit_allocations(funding_lot_id, id)
  where funding_lot_id is not null;

create table credit_pack_clawback_debts (
  order_id uuid primary key,
  account_id uuid not null references billing_accounts(id) on delete restrict,
  target_credits bigint not null check (target_credits > 0),
  collected_credits bigint not null default 0 check (collected_credits >= 0),
  released_credits bigint not null default 0 check (released_credits >= 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint credit_pack_debts_order_account_fk foreign key(order_id,account_id)
    references credit_pack_orders(id,account_id) on delete restrict,
  unique(order_id,account_id),
  check (collected_credits + released_credits <= target_credits)
);

comment on table credit_pack_clawback_debts is
  'Durable cross-subscription-epoch debt for refunded or disputed pack funding already spent.';
comment on column credit_pack_clawback_debts.released_credits is
  'Debt canceled because the corresponding product debit was refunded.';

create index credit_pack_clawback_debts_outstanding
  on credit_pack_clawback_debts(account_id, created_at, order_id)
  where collected_credits + released_credits < target_credits;

alter table credit_debits
  add constraint credit_debits_clawback_order_fk
  foreign key (clawback_order_id,account_id)
  references credit_pack_clawback_debts(order_id,account_id) on delete restrict;

create index credit_debits_clawback_order
  on credit_debits(clawback_order_id,created_at,idempotency_key)
  where clawback_order_id is not null;

create function assert_credit_pack_state(target_order_id uuid)
returns void language plpgsql as $$
declare
  order_pack numeric;
  order_refunded numeric;
  lot_id uuid;
  lot_original numeric;
  lot_remaining numeric;
  lot_expired numeric;
  lot_cash_clawed numeric;
  debt_target numeric := 0;
  debt_collected numeric := 0;
  debt_released numeric := 0;
  allocated_outstanding numeric := 0;
  collection_outstanding numeric := 0;
begin
  select pack_credits::numeric,refunded_credits::numeric
    into order_pack,order_refunded
    from credit_pack_orders where id=target_order_id;
  if not found then
    return;
  end if;

  select id,original_credits::numeric,remaining_credits::numeric,
         expired_credits::numeric,cash_clawed_back_credits::numeric
    into lot_id,lot_original,lot_remaining,lot_expired,lot_cash_clawed
    from credit_funding_lots where order_id=target_order_id;
  if not found then
    if exists(select 1 from credit_pack_clawback_debts where order_id=target_order_id) then
      raise check_violation using
        message='credit-pack debt cannot exist before its funding lot';
    end if;
    return;
  end if;

  select target_credits::numeric,collected_credits::numeric,released_credits::numeric
    into debt_target,debt_collected,debt_released
    from credit_pack_clawback_debts where order_id=target_order_id;
  if not found then
    debt_target := 0;
    debt_collected := 0;
    debt_released := 0;
  end if;
  select coalesce(sum((amount-refunded_amount)::numeric),0)
    into allocated_outstanding
    from credit_debit_allocations where funding_lot_id=lot_id;
  select coalesce(sum((a.amount-a.refunded_amount)::numeric),0)
    into collection_outstanding
    from credit_debits d
    join credit_debit_allocations a
      on a.debit_idempotency_key=d.idempotency_key
   where d.kind='credit_pack_debt_collection'
     and d.clawback_order_id=target_order_id;

  if lot_original <> order_pack then
    raise check_violation using
      message='credit-pack lot original amount must equal its order snapshot';
  end if;
  if order_refunded <> lot_cash_clawed + debt_target then
    raise check_violation using
      message='credit-pack cash clawback and debt must equal cumulative refunded credits';
  end if;
  if debt_collected <> collection_outstanding then
    raise check_violation using
      message='credit-pack collected debt must equal outstanding collection allocations';
  end if;
  if order_pack <> lot_remaining + lot_expired + lot_cash_clawed
                   + debt_released + allocated_outstanding then
    raise check_violation using
      message='credit-pack lot funding conservation equation is violated';
  end if;
end;
$$;

create function enforce_credit_pack_state()
returns trigger language plpgsql as $$
declare
  target_order_id uuid;
  previous_order_id uuid;
begin
  if tg_table_name = 'credit_pack_orders' then
    target_order_id := case when tg_op='DELETE' then old.id else new.id end;
    previous_order_id := case when tg_op='UPDATE' then old.id else null end;
  elsif tg_table_name in ('credit_funding_lots','credit_pack_clawback_debts') then
    target_order_id := case when tg_op='DELETE' then old.order_id else new.order_id end;
    previous_order_id := case when tg_op='UPDATE' then old.order_id else null end;
  else
    if tg_op <> 'DELETE' and new.funding_lot_id is not null then
      select order_id into target_order_id
        from credit_funding_lots where id=new.funding_lot_id;
    end if;
    if tg_op <> 'INSERT' and old.funding_lot_id is not null then
      select order_id into previous_order_id
        from credit_funding_lots where id=old.funding_lot_id;
    end if;
  end if;
  if target_order_id is not null then
    perform assert_credit_pack_state(target_order_id);
  end if;
  if previous_order_id is not null and previous_order_id is distinct from target_order_id then
    perform assert_credit_pack_state(previous_order_id);
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;

create constraint trigger credit_pack_orders_state_equation
after insert or update or delete on credit_pack_orders
deferrable initially deferred for each row execute function enforce_credit_pack_state();
create constraint trigger credit_funding_lots_state_equation
after insert or update or delete on credit_funding_lots
deferrable initially deferred for each row execute function enforce_credit_pack_state();
create constraint trigger credit_pack_debts_state_equation
after insert or update or delete on credit_pack_clawback_debts
deferrable initially deferred for each row execute function enforce_credit_pack_state();
create constraint trigger credit_pack_allocations_state_equation
after insert or update or delete on credit_debit_allocations
deferrable initially deferred for each row execute function enforce_credit_pack_state();

create function enforce_credit_pack_collection_state()
returns trigger language plpgsql as $$
declare
  target_order_id uuid;
  previous_order_id uuid;
begin
  if tg_table_name='credit_debits' then
    target_order_id := case when tg_op='DELETE' then old.clawback_order_id
                            else new.clawback_order_id end;
    previous_order_id := case when tg_op='UPDATE' then old.clawback_order_id else null end;
  else
    if tg_op <> 'DELETE' then
      select clawback_order_id into target_order_id
        from credit_debits where idempotency_key=new.debit_idempotency_key;
    end if;
    if tg_op <> 'INSERT' then
      select clawback_order_id into previous_order_id
        from credit_debits where idempotency_key=old.debit_idempotency_key;
    end if;
  end if;
  if target_order_id is not null then
    perform assert_credit_pack_state(target_order_id);
  end if;
  if previous_order_id is not null and previous_order_id is distinct from target_order_id then
    perform assert_credit_pack_state(previous_order_id);
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;

create constraint trigger credit_pack_collection_debits_state_equation
after insert or update or delete on credit_debits
deferrable initially deferred for each row
execute function enforce_credit_pack_collection_state();
create constraint trigger credit_pack_collection_allocations_state_equation
after insert or update or delete on credit_debit_allocations
deferrable initially deferred for each row
execute function enforce_credit_pack_collection_state();

create function enforce_credit_debit_state()
returns trigger language plpgsql as $$
declare
  target_key text;
  previous_key text;
  debit_amount numeric;
  debit_restored numeric;
  debit_refunded_at timestamptz;
  debit_kind text;
  allocated numeric;
  allocation_refunded numeric;
  allocation_count numeric;
begin
  if tg_table_name='credit_debits' then
    target_key := case when tg_op='DELETE' then old.idempotency_key
                       else new.idempotency_key end;
    previous_key := case when tg_op='UPDATE' then old.idempotency_key else null end;
  else
    target_key := case when tg_op='DELETE' then old.debit_idempotency_key
                       else new.debit_idempotency_key end;
    previous_key := case when tg_op='UPDATE' then old.debit_idempotency_key else null end;
  end if;
  select amount::numeric,restored_credits::numeric,refunded_at,kind
    into debit_amount,debit_restored,debit_refunded_at,debit_kind
    from credit_debits where idempotency_key=target_key;
  if not found then
    if tg_op='DELETE' then return old; end if;
    return new;
  end if;
  select coalesce(sum(amount::numeric),0),coalesce(sum(refunded_amount::numeric),0),count(*)
    into allocated,allocation_refunded,allocation_count
    from credit_debit_allocations where debit_idempotency_key=target_key;
  if allocated <> debit_amount then
    raise check_violation using
      message='credit debit allocations must equal the debit amount';
  end if;
  if debit_restored > allocation_refunded then
    raise check_violation using
      message='restored debit credits cannot exceed refunded allocations';
  end if;
  if debit_kind='credit_pack_debt_collection' and allocation_count <> 1 then
    raise check_violation using
      message='credit-pack debt collection debit must have exactly one source allocation';
  end if;
  if (debit_refunded_at is not null) <> (allocation_refunded = debit_amount) then
    raise check_violation using
      message='credit debit terminal refund marker must match allocation progress';
  end if;
  if previous_key is not null and previous_key is distinct from target_key then
    select amount::numeric,restored_credits::numeric,refunded_at,kind
      into debit_amount,debit_restored,debit_refunded_at,debit_kind
      from credit_debits where idempotency_key=previous_key;
    if found then
      select coalesce(sum(amount::numeric),0),coalesce(sum(refunded_amount::numeric),0),count(*)
        into allocated,allocation_refunded,allocation_count
        from credit_debit_allocations where debit_idempotency_key=previous_key;
      if allocated <> debit_amount or debit_restored > allocation_refunded
         or (debit_kind='credit_pack_debt_collection' and allocation_count <> 1)
         or (debit_refunded_at is not null) <> (allocation_refunded = debit_amount) then
        raise check_violation using
          message='previous credit debit allocation equation is violated';
      end if;
    end if;
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;

create constraint trigger credit_debits_state_equation
after insert or update or delete on credit_debits
deferrable initially deferred for each row execute function enforce_credit_debit_state();
create constraint trigger credit_debit_allocations_debit_equation
after insert or update or delete on credit_debit_allocations
deferrable initially deferred for each row execute function enforce_credit_debit_state();

create table checkout_claims (
  account_id uuid primary key references billing_accounts(id) on delete cascade,
  claim_token uuid not null unique,
  session_id text unique,
  plan_key text not null,
  plan_interval text not null check (plan_interval in ('month', 'year')),
  request_customer_id text,
  expires_at timestamptz not null,
  client_request_key text,
  session_url text,
  created_at timestamptz not null default now()
);

comment on column checkout_claims.request_customer_id is
  'Immutable Checkout request Customer. NULL means subscription Checkout creates one without retaining an email prefill.';

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
