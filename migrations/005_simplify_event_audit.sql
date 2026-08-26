-- Stop using payload hashing as a runtime or readiness boundary while preserving a
-- backward-compatible rolling upgrade from 0.2.1. New code no longer writes this
-- column. It remains nullable for one compatibility window so an older replica can
-- finish in-flight work without failing its INSERT column list; a later major migration
-- may remove the column after all 0.2.1 processes are gone.

alter table stripe_webhook_events
  drop constraint if exists stripe_webhook_events_payload_audit_ck;

alter table stripe_webhook_events
  drop constraint if exists stripe_webhook_events_payload_sha256_ck;

update stripe_webhook_events
   set payload_sha256=null
 where payload_sha256 is not null;

comment on column stripe_webhook_events.payload is
  'Redacted audit snapshot; not the exact signed request body.';

comment on column stripe_webhook_events.payload_sha256 is
  'Deprecated rolling-upgrade compatibility column; 0.2.2 and later write NULL.';
