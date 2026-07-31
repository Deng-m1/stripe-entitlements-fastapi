# Release checklist

## Scope and evidence

- [ ] State the supported single-item/USD/fixed-plan scope and relevant non-goals.
- [ ] Link every billing behavior change to an invariant and migration.
- [ ] Separate automated PostgreSQL, automated real Stripe, manual test-mode and
      production evidence.
- [ ] Do not describe the one-hour Test Clock readiness smoke as renewal or
      plan-change lifecycle coverage.
- [ ] Record outbound request API version and webhook Event snapshot API version
      separately.

## Locked verification

- [ ] `uv sync --frozen`
- [ ] `uv run ruff check .`
- [ ] `uv run mypy src`
- [ ] `uv run pytest -m "not real_stripe"`
- [ ] `cd web && npm ci`
- [ ] `cd web && npm audit --omit=dev`
- [ ] `cd web && npm run lint`
- [ ] `cd web && npm run typecheck`
- [ ] `cd web && npm test`
- [ ] `cd web && npm run build`
- [ ] `git diff --check`

## Stripe test-mode gates

- [ ] Confirm the key starts with `sk_test_` before any automated real call.
- [ ] Run `uv run pytest -m real_stripe -v` when Stripe object/payload parsing
      changed; record counts and skipped tests.
- [ ] Verify the automated real full-price/no-proration monthly transition.
- [ ] Verify the automated real annual-origin two-phase Schedule.
- [ ] Re-run affected manual scenarios:
  - [ ] annual-origin previews such as `PY → UM` remain period-end;
  - [ ] decline/pending update retains old entitlement and provides recovery.
- [ ] Confirm immediate requests use `billing_cycle_anchor=now` with
      `proration_behavior=none` and start a separately funded full-price period.
- [ ] Redact all customer, Event, Invoice, Subscription, payment and recovery data.
- [ ] Record the actual Event `api_version`; do not infer it from request version.

## Database and deployment

- [ ] Back up all eight correctness tables together.
- [ ] Apply `001_schema.sql` and `002_plan_transitions.sql` before new code.
- [ ] Verify restore/PITR and run reconciliation in staging.
- [ ] Confirm all replicas use identical catalog, migrations, product-line and
      version settings.
- [ ] Verify annual/reconciliation scheduler configuration and alerts.
- [ ] Verify unresolved incidents, stale leases and webhook 5xx dashboards.

## Live cutover

- [ ] Replace demo auth with a verified production `AuthAccountAdapter`.
- [ ] Run live catalog/Portal bootstrap only with explicit `--allow-live` approval.
- [ ] Verify Portal price changes are disabled and cancellation is period-end.
- [ ] Configure allowlisted Checkout/Portal/frontend URLs.
- [ ] Create a live endpoint with only supported Event types and a new signing secret.
- [ ] Set `STRIPE_WEBHOOK_API_VERSION` from that endpoint's real snapshot.
- [ ] Run low-risk Checkout, hosted-invoice recovery and webhook-projection smoke.
- [ ] Confirm browser return/POST success never grants access before account projection.

## Publish

- [ ] Update README/docs, changelog and version metadata without overstating evidence.
- [ ] Confirm CI `Backend` and `Web` jobs pass from a clean clone.
- [ ] Review dependency/security alerts and license changes.
- [ ] Tag with a signed/annotated version and publish release notes.
- [ ] Include migrations, compatibility, evidence boundary, rollback and known limits.
