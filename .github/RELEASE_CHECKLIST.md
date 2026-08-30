# Release checklist

## Scope and evidence

- [ ] State the supported single-item/USD/fixed-plan and card-funded credit-pack scope,
      plus relevant non-goals.
- [ ] Link every billing behavior change to an invariant and migration.
- [ ] Separate automated PostgreSQL, automated real Stripe, manual test-mode and
      production evidence.
- [ ] Bind every pass claim to the exact commit. Clean `f757fcc` passed 1,257 Python tests
      with 10 `real_stripe` tests deselected, 816 TypeScript tests across 50 files, and 208
      Web tests across 19 files, plus both 10/10 Stripe test-mode suites, four
      browser/backend-policy endpoint runs, final artifacts, and the hardened container.
      Do not relabel those results for a later runtime-changing commit; rerun the affected
      gates. Keep older
      239/7/60/2 and 270/9/62/2 results historical, and do not relabel the failed
      pre-state Quick Tunnel attempt as endpoint evidence.
- [ ] Cite Test Clock renewal/annual-slot evidence only when the full annual lifecycle
      test actually ran; a collected or skipped test is not evidence.
- [ ] Record outbound request API version and webhook Event snapshot API version
      separately.

## Locked verification

- [ ] `uv sync --frozen`
- [ ] `uv run python scripts/check_release_versions.py`
- [ ] `uv run ruff format --check .`
- [ ] `uv run ruff check .`
- [ ] `uv run mypy src`
- [ ] `uv run pytest -m "not real_stripe"`
- [ ] `uv audit`
- [ ] `cd typescript && npm ci`
- [ ] Release runner uses Node 22.22.0 and pinned npm 11.19.1; do not rely on the
      older npm bundled with Node for OIDC trusted publishing.
- [ ] `cd typescript && npm audit --omit=dev && npm audit`
- [ ] `cd typescript && npm run check`
- [ ] Pack the npm artifact, install it in a clean project, run its CLI, import every
      documented export, and compare packaged migration/catalog/license files with the
      repository canonicals.
- [ ] From a second clean install of that exact `.tgz`, run the installed (not source-tree)
      CLI against a fresh disposable PostgreSQL 17 database; require exact 001/002
      filename/SHA-256 history, idempotent re-apply, all correctness tables, all six 002
      snapshot columns, and `Database.schemaReady() === true`.
- [ ] Install that exact `.tgz` into the locked minimal Next.js consumer and require a
      production App Router build of the billing catch-all, Stripe webhook, and health
      Route Handlers.
- [ ] Require Registry 404 vacancy or byte-identical existing `dist.integrity`, publish
      the already-verified `.tgz` without repacking, then verify Registry integrity,
      SLSA provenance metadata/signatures, version, CLI, and all four public ESM exports
      from a fresh anonymous exact-version install.
- [ ] Run `stripe-entitlements doctor --json` against the release database and retain a
      secret-free report; do not label it Stripe endpoint or payload evidence.
- [ ] `cd web && npm ci`
- [ ] `cd web && npm audit --omit=dev`
- [ ] `cd web && npm audit`
- [ ] `cd web && npm run lint`
- [ ] `cd web && npm run typecheck`
- [ ] `cd web && npm test`
- [ ] `cd web && npx playwright install --with-deps chromium`
- [ ] `cd web && npm run test:e2e:simulation`
- [ ] `cd web && npm run build`
- [ ] `git diff --check`

## Stripe test-mode gates

- [ ] Confirm the key starts with `sk_test_` before any automated real call.
- [ ] Run `uv run pytest -m real_stripe -v` when Stripe object/payload parsing
      changed; require all 10 current cases to execute and record counts/skips.
- [ ] Run `cd typescript && npm run test:real-stripe` when TypeScript Stripe
      object/payload parsing changed; require every current case plus strict cleanup and
      zero run-owned residual inventory.
- [ ] Verify the real credit-pack PaymentIntent, immutable metadata, Customer/Charge
      lineage, partial/full cash clawback, product refund interaction, and strict cleanup.
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
- [ ] Run `scripts/run_browser_e2e.sh` for Python and TypeScript, once with each
      transition policy (four runs), against an isolated test account and record:
  - [ ] Checkout decline left the browser-visible account Free;
  - [ ] the same `cs_test_` Session completed the test 3DS challenge;
  - [ ] the UI confirmed only the webhook-projected Starter/Monthly/300 state;
  - [ ] the browser previewed/confirmed the selected upgrade policy, completed the
        default Stripe.js upgrade SCA, and a second paid projection reached
        Pro/Monthly/1,000;
  - [ ] delta created one 700-credit allocation; full-period created none;
  - [ ] exactly five essential Events were identity-bound to the account: subscription
        Checkout completion, initial and settlement `invoice.paid`, credit-pack Checkout
        completion, and the pack `payment_intent.succeeded`; do not require an incidental
        total Event count;
  - [ ] the pack success screen waited for the exact webhook-funded lot, Portal creation
        returned through the real hosted flow, and the Job example completed
        charge/replay/refund without cross-wiring an owner, Job, attempt, or allocation;
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

- [ ] Verify `1 credit = 1000000 atoms` across catalog, account API, plan-change delta,
      annual grant, usage charge/refund and clawback paths.
- [ ] Verify minimum `0.000001`, equivalent decimal spellings, values above JavaScript's
      safe-integer range, explicit overflow rejection and concurrent fractional charges.
- [ ] Confirm Stripe cash minor-unit columns were not scaled or reinterpreted as product
      credits.

- [ ] Back up all fourteen correctness tables together.
- [ ] For 0.3, initialize a fresh database with `001_v3_baseline.sql`; do not attempt an
      in-place upgrade from a v0.2.x migration history.
- [ ] Recreate every v0.2.x development, demo, and staging database before using 0.3;
      verify both old-to-new and new-to-old lineage mixing fails without partial DDL.
- [ ] After the 0.3 baseline is released, freeze its filename and checksum and append
      `002_...sql` or later for every schema change.
- [ ] For 0.4.0, verify fresh installation applies byte-identical 001 + 002, and verify an
      existing 0.3 database atomically applies only `002_stripe_request_snapshots.sql`.
- [ ] Verify failed 002 application leaves no snapshot columns/constraints/history row,
      then succeeds unchanged on retry.
- [ ] Verify legacy rows remain `request_snapshot_version IS NULL`, new reservations use
      0, and only strict frozen JSON request snapshots use version 1.
- [ ] Quiesce subscription Checkout, credit-pack Checkout, and plan-change writers before
      applying 002; replace every v0.3 writer with v0.4 before reopening those routes.
- [ ] Do not roll remote-mutation writers back to v0.3 after v0.4 accepts traffic unless
      writes are stopped and every in-flight v1/remote-started row is reconciled or retired.
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
- [ ] For the brand-new npm package only, create a least-scope, short-expiry granular
      token with bypass-2FA publishing, store it temporarily as the `NPM_TOKEN` Actions
      secret, and let the tag workflow validate that credential before reserving a draft
      Release, then publish with provenance. Never paste it into an issue, PR, log, or
      chat.
- [ ] Immediately after the first npm publish, configure the package Trusted Publisher
      as `Deng-m1` / `stripe-entitlements-fastapi` / `release.yml` with `npm publish`
      permission, select “Require 2FA and disallow tokens,” delete the Actions secret,
      and revoke the bootstrap token. Later releases must use OIDC only.
- [ ] Before creating `v*`, require an active GitHub tag ruleset targeting
      `refs/tags/v*` that blocks updates and deletion with no ordinary bypass. The
      workflow's repeated tag-object checks do not replace server-side immutability.
- [ ] Before the first release tag, bootstrap the repository-named GHCR container
      package, explicitly change its visibility to public, and verify that an
      unauthenticated client can read it. The release workflow refuses a missing/private
      package, then anonymously inspects and pulls the exact published digest using a
      fresh Docker config with no credentials.
- [ ] Apply the GitHub description/topics from `.github/REPOSITORY_METADATA.md`.
- [ ] Set one canonical HTTPS `NEXT_PUBLIC_SITE_URL`; enable indexing only there.
- [ ] Verify canonical/robots/sitemap/social-image responses and keep account/billing
      return routes `noindex` using `docs/SEO.md`.
- [ ] Confirm visible landing, plan, savings and FAQ copy matches JSON-LD and the
      enforced catalog; do not advertise unsupported coupons, trials, tax or currency.
- [ ] Confirm CI `Backend`, `TypeScript billing core`, `Container`, and `Web` jobs pass
      from a clean clone. Backend
      must install the Wheel independently and apply the complete baseline to fresh
      PostgreSQL; Container must do the same from the built image, then return
      `ok=true`/`database=true` from host `curl` while UID/GID 10001 and read-only.
- [ ] Run `scripts/build_distributions.sh` in an empty output directory; it must build
      the sdist first, unpack that exact archive, and build the only release Wheel from
      the unpacked source. Verify the artifact boundary: Wheel contains the
      backend package/catalog/migrations; sdist additionally contains `.env` templates,
      scripts, Docker/Compose, examples, tests, and `web/`, with no `.next`, `node_modules`,
      Playwright report, or test-result directories.
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
- [ ] Tag with an annotated `v<project-version>` only after all applicable networked
      gates above are bound to that exact commit. The tag workflow reruns network-free
      backend/web gates, creates Wheel/sdist checksums, publishes or byte-verifies the
      exact npm artifact, and publishes exact/minor/commit/latest GHCR tags without
      allowing an older patch to roll back either moving channel. The
      immutable commit tag uses the complete Git commit SHA. It refuses an existing
      Release, version image tag, or commit image tag, rechecks the annotated tag object,
      reserves a draft Release before publishing the immutable image, uploads and verifies
      the draft assets, publishes and digest-verifies every moving tag, and makes the
      GitHub Release public only as the final commit point. It proves every container tag
      resolves to one digest and records that digest; it does not substitute for real
      Stripe or live-payload evidence.
- [ ] If publication stops after reserving the draft Release or pushing only part of the
      immutable/moving tag set, do not blindly rerun: the vacancy guards intentionally
      fail. Inspect the remote tag object, draft/public Release, npm exact version,
      `dist.integrity`, provenance, dist-tag, OCI exact-version tag, full-SHA tag, and each
      digest. Never unpublish an npm version to make a retry convenient; if its bytes and
      provenance match, finish the same verified release under administrator review. Only
      remove an unpublished draft or recoverable OCI partial state. Record the recovery
      decision, npm integrity, and final container digest in the private release log.
- [ ] Download the published GitHub assets, verify `SHA256SUMS`, install the Wheel in a
      clean environment, and require `stripe-entitlements --version` to equal the tag.
- [ ] Install the downloaded `.tgz` in a second clean Node project; require its CLI
      version, public ESM exports, catalog, licenses, and both migration bytes to match
      the tag and repository canonicals, then repeat the fresh PostgreSQL migration
      contract with that downloaded artifact.
- [ ] From a third clean project, install
      `@tosea/stripe-entitlements@<exact-version>` from the public Registry and require
      its `dist.integrity`, CLI, exports, catalog, licenses, and migrations to match the
      release tarball. Verify the expected dist-tag only after this succeeds.
- [ ] Pull the image by the recorded digest, require the same CLI version, apply the fresh
      migration set, and repeat the non-root/read-only health smoke before announcing release.
- [ ] Record that the release workflow currently publishes a native `linux/amd64` image;
      do not advertise ARM64/multi-architecture support until a verified manifest exists.
- [ ] Include migrations, compatibility, evidence boundary, rollback and known limits.
