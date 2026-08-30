alter table checkout_claims
  add column request_snapshot_version smallint,
  add column stripe_request_snapshot jsonb,
  add constraint checkout_claims_request_snapshot_state_check check ((
    (request_snapshot_version is null and stripe_request_snapshot is null)
    or (request_snapshot_version = 0 and stripe_request_snapshot is null)
    or (
      request_snapshot_version = 1
      and stripe_request_snapshot is not null
      and jsonb_typeof(stripe_request_snapshot) = 'object'
    )
  ) is true);

comment on column checkout_claims.request_snapshot_version is
  'NULL marks a pre-002 request that cannot be safely replayed; 0 is reserved; 1 is a frozen Stripe Checkout create snapshot';
comment on column checkout_claims.stripe_request_snapshot is
  'Strict versioned, secret-free Stripe Checkout Session create request used for exact same-key recovery';

alter table credit_pack_orders
  add column request_snapshot_version smallint,
  add column stripe_request_snapshot jsonb,
  add constraint credit_pack_orders_request_snapshot_state_check check ((
    (request_snapshot_version is null and stripe_request_snapshot is null)
    or (request_snapshot_version = 0 and stripe_request_snapshot is null)
    or (
      request_snapshot_version = 1
      and stripe_request_snapshot is not null
      and jsonb_typeof(stripe_request_snapshot) = 'object'
    )
  ) is true);

comment on column credit_pack_orders.request_snapshot_version is
  'NULL marks a pre-002 request that cannot be safely replayed; 0 is reserved; 1 is a frozen Stripe Checkout create snapshot';
comment on column credit_pack_orders.stripe_request_snapshot is
  'Strict versioned, secret-free Stripe Checkout Session create request used for exact same-key recovery';

alter table billing_plan_changes
  add column request_snapshot_version smallint,
  add column stripe_request_snapshot jsonb,
  add constraint billing_plan_changes_request_snapshot_state_check check ((
    (request_snapshot_version is null and stripe_request_snapshot is null)
    or (request_snapshot_version = 0 and stripe_request_snapshot is null)
    or (
      request_snapshot_version = 1
      and stripe_request_snapshot is not null
      and jsonb_typeof(stripe_request_snapshot) = 'object'
    )
  ) is true);

comment on column billing_plan_changes.request_snapshot_version is
  'NULL marks a pre-002 intent; 0 is not remotely started and unfrozen; 1 is a frozen Stripe mutation snapshot';
comment on column billing_plan_changes.stripe_request_snapshot is
  'Strict versioned, secret-free Stripe Subscription or Schedule mutation request used for exact same-key recovery';
