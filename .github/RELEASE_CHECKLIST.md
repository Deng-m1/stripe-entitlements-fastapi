# Release checklist

## Scope and evidence

- [ ] State the supported single-item/USD/fixed-plan scope and relevant non-goals.
- [ ] Link every billing behavior change to an invariant and migration.
- [ ] Separate automated PostgreSQL, automated real Stripe, manual test-mode and
      production evidence.
- [ ] Bind every pass claim to the exact commit. The review candidate based on
      `main@4df7f73` provisionally passed 787 PostgreSQL tests and 155 frontend tests; it
      is not evidence for that base commit. Replace this label after the final commit and
      full rerun. The 0.3 candidate passed 9 real Stripe cases and 2 CLI-transport browser
      policies; label older 239/7/60/2 and 270/9/62/2 results as historical, and do not
      relabel the failed pre-state Quick Tunnel attempt as endpoint evidence.
- [ ] Cite Test Clock renewal/annual-slot evidence only when the full annual lifecycle
      test actually ran; a collected or skipped test is not evidence.
- [ ] Record outbound request API version and webhook Event snapshot API version
      separately.

## Locked verification

- [ ] `uv sync --frozen`
- [ ] `uv run ruff format --check .`
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
      changed; require all 9 current cases to execute and record counts/skips.
- [ ] Verify the automated real full-price/no-proration monthly transition.
- [ ] Verify the automated real prorated-delta transition, source allocation, and full
      refund reversion.
- [ ] Verify the automated real annual-origin two-phase Schedule.
- [ ] Verify the automated failed-immediate matrix for both policies and both Payment
      Method fixtures:
  - [ ] authentication-required produces `pending_update`/recovery and keeps old access;
  - [ ] attachable customer-charge failure produces `pending_update` and keeps old access.
  - [ ] paid/failed Events match the compare-and-set settlement Invoice; an unbound or
        delayed older failure creates an incident without changing the new intent.
  - [ ] a paid webhook racing coordinator finish binds the same Invoice atomically;
        blocked-paid completion makes confirm return conflict, never false success.
- [ ] Verify the automated Test Clock annual lifecycle:
  - [ ] run `scripts/run_test_clock_e2e.sh` and require a passed test, not a skip;
  - [ ] initial paid annual invoice created slot 1;
  - [ ] +32 days created slot 2;
  - [ ] the downtime jump created one current slot without backfill;
  - [ ] `period_end + 1 hour` produced and projected a paid renewal invoice;
  - [ ] every Stripe inventory list used complete auto-pagination;
  - [ ] post-cleanup inventory contained zero non-canceled Subscriptions, Customers,
        active Prices/Products, Test Clocks and unfinished Schedules for the run ID;
  - [ ] successful cleanup removed the recovery manifest/directory, while an injected
        failure or interruption retained a mode-`0600`, secret-free manifest with exact
        recovery IDs.
- [ ] Re-run affected manual scenarios:
  - [ ] annual-origin previews such as `PY → UM` remain period-end;
  - [ ] decline/pending update retains old entitlement and provides recovery.
- [ ] Run `scripts/run_browser_e2e.sh` once with each transition policy against an
      isolated test account and record:
  - [ ] Checkout decline left the browser-visible account Free;
  - [ ] the same `cs_test_` Session completed the test 3DS challenge;
  - [ ] the UI confirmed only the webhook-projected Starter/Monthly/300 state;
  - [ ] the browser previewed/confirmed the selected upgrade policy, completed the
        default Stripe.js upgrade SCA, and a second paid projection reached
        Pro/Monthly/1,000;
  - [ ] delta created one 700-credit allocation; full-period created none;
  - [ ] exactly three essential Events were identity-bound to the account, Checkout,
        initial Invoice, settlement Invoice, grants, and allocation; do not require the
        historical incidental total of five;
  - [ ] each additional account-matched Event ID/type/mode matched Stripe's Event API
        truth and no related unresolved incident remained;
  - [ ] signed payload version matched the endpoint contract, while the independently
        retrieved Event API view version was recorded separately.
- [ ] Verify the full runner kept the test key/DSN in the Node helper, omitted them from
      Next.js, and launched Chromium with the runtime-only environment allowlist.
- [ ] For remote staging, use a private mode-`0600` `E2E_STORAGE_STATE` bound to the
      exact `E2E_EXTERNAL_REF`; record that standalone mode lacks wrapper-owned final
      verification and cleanup.
- [ ] For `full_period_reset`, confirm immediate requests use
      `billing_cycle_anchor=now` with `proration_behavior=none`.
- [ ] For `prorated_delta`, confirm preview/apply share one persisted
      `proration_date`, use `always_invoice`, retain the anchor, and accept only the
      bounded two-line monthly shape.
- [ ] Redact all customer, Event, Invoice, Subscription, payment and recovery data.
- [ ] Record the actual Event `api_version`; do not infer it from request version.

## Database and deployment

- [ ] Back up all ten correctness tables together.
- [ ] For 0.3, initialize a fresh database with `001_v3_baseline.sql`; do not attempt an
      in-place upgrade from a v0.2.x migration history.
- [ ] Recreate every v0.2.x development, demo, and staging database before using 0.3;
      verify both old-to-new and new-to-old lineage mixing fails without partial DDL.
- [ ] After the 0.3 baseline is released, freeze its filename and checksum and append
      `002_...sql` or later for every schema change.
- [ ] Verify every bundled migration checksum; tolerate later migration rows only when
      the runtime/schema change remains backward-compatible during rolling deployment.
- [ ] Verify restore/PITR and run reconciliation in staging.
- [ ] Confirm all replicas use the same catalog, transition policy, product-line, Stripe
      version settings, and mutually compatible migration sets.
- [ ] Verify annual/reconciliation scheduler configuration and alerts.
- [ ] Verify unresolved incidents, stale leases, `applying` age/23-hour alerts,
      clawback debt, and webhook 5xx dashboards.
- [ ] Verify `closure_applied` remains intact across restore/reconciliation so distinct
      refund/dispute Event IDs cannot repeat a terminal funding closure.

## Live cutover

- [ ] Replace demo auth with a verified production `AuthAccountAdapter`.
- [ ] Run live catalog/Portal bootstrap only with explicit `--allow-live` approval.
- [ ] Verify Portal price changes are disabled and cancellation is period-end.
- [ ] Configure allowlisted Checkout/Portal/frontend URLs.
- [ ] Create a live endpoint with only supported Event types and a new signing secret.
- [ ] Set `STRIPE_WEBHOOK_API_VERSION` from that endpoint's real snapshot.
- [ ] Run low-risk Checkout, hosted-invoice recovery and webhook-projection smoke.
- [ ] Confirm browser return/POST success never grants access before account projection.
- [ ] Complete the private evidence record in `docs/WEBHOOK_VERIFICATION.md`; if no
      approved live credential/event exists, record the gate as not run.

## Publish

- [ ] Update README/docs, changelog and version metadata without overstating evidence.
- [ ] Apply the GitHub description/topics from `.github/REPOSITORY_METADATA.md`.
- [ ] Set one canonical HTTPS `NEXT_PUBLIC_SITE_URL`; enable indexing only there.
- [ ] Verify canonical/robots/sitemap/social-image responses and keep account/billing
      return routes `noindex` using `docs/SEO.md`.
- [ ] Confirm visible landing, plan, savings and FAQ copy matches JSON-LD and the
      enforced catalog; do not advertise unsupported coupons, trials, tax or currency.
- [ ] Confirm CI `Backend`, `Container`, and `Web` jobs pass from a clean clone. Backend
      must install the Wheel independently and apply the complete baseline to fresh
      PostgreSQL; Container must do the same from the built image, then return
      `ok=true`/`database=true` from host `curl` while UID/GID 10001 and read-only.
- [ ] Review dependency/security alerts and license changes.
- [ ] When publishing a demo video:
  - [ ] record only isolated Stripe test mode and show an explicit test-mode label;
  - [ ] keep raw Checkout videos/traces private and outside Git history;
  - [ ] build the redacted cut with `scripts/build_promo_video.sh`;
  - [ ] run `scripts/review_promo_video.sh`, require the 15-scene semantic gate to
        pass, and inspect every transition, payment mask, 3DS screen, entitlement state,
        and final repository URL;
  - [ ] confirm the OCR privacy gate finds no test subject, email, card, expiry, or
        cardholder data;
  - [ ] describe CLI signed forwarding separately from endpoint-metadata evidence;
  - [ ] unless a new cut is recorded and reviewed, label the 48.800-second video as the
        `0.2.0` visual artifact rather than `0.2.2` code/network evidence.
- [ ] Tag with a signed/annotated version and publish release notes.
- [ ] Include migrations, compatibility, evidence boundary, rollback and known limits.
