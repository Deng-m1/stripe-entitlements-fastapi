-- Make the durable Invoice-owner contract match its effective retention behavior.
--
-- The immutable-owner trigger from migration 002 already prevented an account delete
-- from clearing stripe_invoice_state.account_id, despite migration 001 declaring
-- ON DELETE SET NULL. Billing accounts with funding history are audit records and must
-- not be deleted independently from their Invoice state, ledger, allocations, inbox,
-- debts, and incidents. Declare that restriction directly at the foreign key.

alter table stripe_invoice_state
  drop constraint if exists stripe_invoice_state_account_id_fkey;

alter table stripe_invoice_state
  add constraint stripe_invoice_state_account_id_fkey
  foreign key (account_id) references billing_accounts(id) on delete restrict;

-- Reconciliation resolves only incidents observed before its database attempt token.
-- PostgreSQL now() is fixed at transaction start, so it cannot represent the causal
-- observation time of an incident written later by a long-running transaction. Use the
-- statement wall clock for new rows and pair it with explicit clock_timestamp() writes
-- in every conflict-update path.
alter table billing_incidents
  alter column last_seen_at set default clock_timestamp();

-- Keep the bounded causal lookup away from a full unresolved-incident scan as history
-- grows.
create index if not exists billing_incidents_unresolved_account_kind_seen
  on billing_incidents(account_id, kind, last_seen_at, id)
  where resolved_at is null;
