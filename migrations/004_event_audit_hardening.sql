alter table stripe_webhook_events
  add column if not exists payload_sha256 text;

-- Pre-hardening rows stored the full Stripe Event JSON, which can contain customer PII,
-- hosted Invoice URLs, and confirmation/client secrets. Exact signed bytes were not
-- retained, so no trustworthy raw-body digest can be reconstructed. Replace those
-- historical payloads with a minimal audit tombstone before adding the new contract.
update stripe_webhook_events
   set payload=jsonb_build_object(
         'id',id,
         'type',event_type,
         'livemode',livemode,
         'historical_payload','[redacted]'
       )
 where payload_sha256 is null
   and payload->>'historical_payload' is distinct from '[redacted]';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'stripe_webhook_events_payload_sha256_ck'
       AND conrelid = 'stripe_webhook_events'::regclass
  ) THEN
    ALTER TABLE stripe_webhook_events
      ADD CONSTRAINT stripe_webhook_events_payload_sha256_ck
      CHECK (payload_sha256 is null or payload_sha256 ~ '^[0-9a-f]{64}$');
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'stripe_webhook_events_payload_audit_ck'
       AND conrelid = 'stripe_webhook_events'::regclass
  ) THEN
    ALTER TABLE stripe_webhook_events
      ADD CONSTRAINT stripe_webhook_events_payload_audit_ck
      CHECK (
        payload_sha256 is not null
        or payload->>'historical_payload' is not distinct from '[redacted]'
      );
  END IF;
END
$$;

comment on column stripe_webhook_events.payload is
  'Redacted audit snapshot; not the exact signed request body.';
comment on column stripe_webhook_events.payload_sha256 is
  'SHA-256 of the exact signed request bytes when received over HTTP, otherwise canonical Event JSON.';
