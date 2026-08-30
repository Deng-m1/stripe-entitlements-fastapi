# Changelog

## Unreleased

## 0.4.0 - 2026-08-30

- Prevent TypeScript subscription reconciliation from reusing a mutable Stripe
  Subscription snapshot after losing its local projection compare-and-set. The bounded
  retry now rereads and validates Stripe state; a second race stops fail-closed with a
  durable incident instead of overwriting newer webhook status, cancellation, or period
  facts.
- Normalize every PostgreSQL `timestamptz` exposed by the TypeScript public and internal
  HTTP contracts to RFC 3339 without truncating microseconds.
- Make source-checkout CLI setup, packaged-catalog Vercel configuration, and the FastAPI
  product-identity example reproducible, with documentation contract regressions.
- Add an explicitly acknowledged, credential-free, noindex public simulation with
  versioned per-tab state, delayed subscription/upgrade/credit-pack projection, Portal
  return/reset flows, server-route isolation, Stripe.js lazy loading, and a dedicated
  frontend-only Vercel topology.
- Add a production-build Chromium simulation gate that attests the target before any
  interaction, proves no Stripe/API/webhook network traffic, checks reload/context
  isolation, and fails closed when browser storage is unavailable.
- Add a bounded Supabase browser-token transport adapter and AI-builder guide while
  documenting the strict generic JWT `nbf`/UUID requirements, subject-change cleanup,
  HttpOnly BFF option, unpublished npm boundary, and separate test/live evidence levels.

- Bump the coordinated Python, TypeScript, reference web, and citation metadata to
  `0.4.0`; the immutable `v0.3.0` tag continues to identify the earlier Python-only
  release line.
- Add an independent TypeScript/Node/Next.js billing implementation over the canonical
  PostgreSQL schema and `plans.toml`, including native webhook projection, both plan
  transition templates, yearly grants, fractional credits, credit packs, reconciliation,
  personal/team auth starters, internal entitlement APIs, Node CLI, Fetch facade, and
  Next.js Route Handlers.
- Add append-only migration `002_stripe_request_snapshots.sql` and versioned, validated
  Stripe mutation snapshots for subscription Checkout, credit-pack Checkout, and plan
  changes. Same-key unknown-result recovery now replays the frozen Price, URL, Customer
  mode, product-line, API-version, parameters, and Stripe idempotency identity instead
  of rereading mutable deployment configuration; legacy unfrozen remote mutations fail
  closed for operator reconciliation.
- Add TypeScript unit, golden-vector, PostgreSQL constraint/race, cross-runtime credit,
  real Stripe test-mode, package-install, and selectable shared-browser E2E gates. The
  browser runner now executes one Playwright journey against either Python or TypeScript
  and retains the same signed-webhook/database verifier.
- Add a pure TypeScript Vercel topology, npm adoption guide, environment template, package
  metadata, and dual-runtime architecture/deployment documentation.
- Add a stable Vercel Services topology that deploys the Next.js reference UI and the
  existing FastAPI billing core behind one domain, without requiring Railway or a second
  public backend deployment.
- Add constant-time `CRON_SECRET` authorization and bounded, retryable annual-grant and
  subscription/credit-pack reconciliation routes for Vercel Cron. Their responses expose
  aggregate counts only and preserve PostgreSQL as the distributed coordination layer.
- Add an explicit frontend `same-origin` API mode that still requires the host's real
  authentication adapter, plus deployment, concurrency, configuration, and routing tests.
- Document managed PostgreSQL, personal JWT, isolated preview resources, Stripe webhook,
  local Vercel CLI, migration, and production-verification requirements.

## 0.3.0 - 2026-08-28

- Add exact fractional product credits with a fixed protocol of one million integer
  atoms per credit. Catalog decimal strings, Python `CreditAmount`, PostgreSQL balances,
  entitlement deltas, refunds, annual grants and clawback debts remain exact; HTTP and
  TypeScript use validated decimal/atom strings instead of floating-point numbers.
- Add a secret-safe, read-only `stripe-entitlements doctor` command with JSON output for
  package, catalog, configuration, PostgreSQL schema and migration checks. Optional
  Stripe Account/Portal retrieval requires explicit `--stripe-network` opt-in and does
  not claim webhook endpoint or signed-delivery evidence.
- Let `stripe-entitlements migrate` load only `DATABASE_URL`, so a least-privilege schema
  init Job never needs Stripe API or webhook credentials.
- Align source and distribution version metadata at `0.3.0`. Keep the Wheel limited to
  the backend runtime, catalog, and migrations; make the source distribution a complete
  reproducible template with environment files, scripts, Docker/Compose, examples, tests,
  and the Next.js UI; ship the PEP 561 `py.typed` marker and verify both artifact
  boundaries in CI.
- Add `BillingKernel` / `BillingServices`, a native billing `APIRouter`, and
  `install_billing` for existing FastAPI roots. Installation composes the host lifespan,
  preserves database-pool ownership, publishes prefixed OpenAPI routes, scopes billing
  middleware to billing routes, hardens internal routes without granting browser CORS,
  prevents a `Database` object from being owned by multiple kernels, and leaves host
  logging and unrelated routes unchanged.
- Add strict asymmetric JWT/JWKS personal and team authentication starters. Team tenant
  claims remain selectors backed by live membership; an explicit prefix-aware capability
  policy permits viewers to read only catalog routes and reserves account/recovery state
  and mutations for billing administrators.
- Add `EntitlementService` and an optional internal check/charge/refund router. Workload
  authentication, operation scope, and a separate workload-to-owner authorization check
  all fail closed by default, preventing a global service scope from becoming cross-owner
  credit authority.
- Add fixed-price card-funded one-time credit packs with Hosted Checkout, signed
  `payment_intent.succeeded` grant authority, independently expiring funding lots, FEFO
  multi-source consumption, exact debit allocations, partial/full cash refunds,
  disputes, product-operation refunds, and durable cross-epoch clawback debt. The
  reference explicitly selects `card` instead of inheriting untested automatic payment
  methods from Dashboard configuration.
- Add a fenced credit-pack reconciler that retrieves one persisted Session,
  PaymentIntent, and Charge outside PostgreSQL transactions, then reuses the normal
  transactional Event projector. A Checkout create with no durable `cs_` remains
  recoverable only by the original caller replaying the same idempotency key.
- Snapshot the pack Checkout's pre-existing-Customer-or-create request mode before the
  Stripe call. Same-key recovery no longer changes parameters when an early webhook
  binds the Customer/Session or the host login email changes, and it persists a missing
  Session URL without downgrading an already completed order.
- Apply the same immutable Customer/create-mode replay contract to subscription Checkout;
  first-Customer requests omit email instead of persisting mutable login PII solely for
  Stripe idempotency recovery.
- Record webhook `processed_at` with wall-clock completion time rather than PostgreSQL's
  transaction-start `now()`, so audit chronology cannot place a funding lot after the
  Event that already finished creating it.
- Replace recursive webhook audit redaction with a minimal operational allowlist, so
  extensible Stripe tax/custom/free-text fields cannot be retained accidentally.
- Classify subscription and credit-pack Checkout Sessions separately during browser-E2E
  cleanup, so a successful run with one of each closes both instead of treating the
  second run-owned Session as an ambiguous duplicate.
- Add three reference pack tiers to the catalog and Next.js pricing/account/success UI.
  Browser return never grants a pack; success polling requires the exact Checkout
  Session's webhook-projected funding lot.
- Add a runnable host-owned Job, billing outbox, dispatch outbox, queue inbox, lease, and
  fencing example covering unknown charge responses, at-least-once publication,
  execution reclaim, terminal failure, and source-safe refunds. A bounded PostgreSQL demo
  uses an explicitly non-production local billing adapter to exercise the full workflow
  without Stripe network calls and removes only its run-owned rows.
- Bind the Job example's redundant owner/Job/attempt/credit/dispatch identities with
  composite foreign keys, preventing repair scripts or future writers from cross-wiring
  one Job's paid claim to another Job's payload.
- Record an earlier phase-1 working-tree run of 1,110 network-free backend tests and 180
  frontend tests. Final credit-pack contract hardening was applied after that run, so the
  counts are regression history, are not bound to the current tree or a final commit, and
  do not refresh package, container, real Stripe, browser, or production evidence.
- Record the final working-tree candidate rerun: 1,187 network-free PostgreSQL tests, 189
  frontend tests, and all 10 Stripe test-mode cases passed with strict run-owned cleanup.
  Final-commit browser, container, and live-production evidence remain separate gates.

- Replace the pre-release `001`-through-`006` upgrade lineage with one final-state
  `001_v3_baseline.sql` for fresh installations. The baseline directly declares all
  runtime tables, constraints, indexes, defaults, and the immutable Invoice-owner
  trigger; it removes historical backfills, the FK rebuild, and the deprecated
  `payload_sha256` compatibility column.
- Treat the baseline reset as intentionally incompatible with v0.2.x databases. New and
  old migration bundles reject each other's history without partial schema changes;
  development, demo, and staging databases created from v0.2.x must be recreated.
- Harden the real-browser release gate with an atomic private recovery manifest,
  account-owned fallback discovery, post-delete verification, strict Stripe error
  classification, zero-unrelated-Event isolation, and resilient visible-error matching
  across Stripe Checkout's duplicated DOM nodes.

- Make first Invoice ownership atomic across paid, prorated-delta, refund, and dispute
  paths so a conflicting account cannot merge facts before its ownership check.
- Consume Checkout authority on first Subscription binding and terminal deletion, and
  make matching paid/failed settlement Events converge regardless of delivery order.
- Harden reconciliation around ignored synthetic duplicates, per-attempt cancellation
  identity, paid CAS-loss retries, and strictly causal incident cleanup, including
  long-running incident writers and exact failed-attempt resolution;
  include explicit Invoice audit retention, wall-clock observations, and the unresolved-
  incident lookup in the 0.3 baseline.

## 0.2.2 - 2026-08-18

- Remove webhook payload hashing from runtime with `005_simplify_event_audit.sql`, clear
  stored digests, and retain only a nullable compatibility column for one rolling-upgrade
  window. Stripe signatures authenticate delivery, Event IDs
  provide delivery idempotency, and database constraints provide business idempotency;
  the redacted Event audit snapshot remains.
- Simplify readiness to verify required tables and migration-version presence without
  rereading and rehashing migration files on every health probe. The migration command
  continues to enforce immutable checksums before applying SQL.
- Treat Stripe `product_line` metadata as advisory during webhook projection. Exact
  Customer, Subscription, Checkout claim/session, and Price-to-Product identity remain
  the authorization chain, avoiding a duplicate metadata gate on otherwise proven Events.
- Remove the unnecessary SHA-256 transform from Portal idempotency keys; the validated
  caller key is scoped by account and remains below Stripe's key-length limit.
- Verify the `0.2.2` release candidate with 702 local PostgreSQL tests from 711 collected,
  all 9 real Stripe test-mode cases, 102 frontend tests, and both real-browser policies
  through signed Stripe CLI forwarding. Python/npm audits report zero known
  vulnerabilities; an independently installed Wheel applied all five migrations; and the
  non-root, read-only Docker image migrated PostgreSQL and reached a healthy API state.

## 0.2.1 - 2026-08-18

- Harden signed Event processing around Customer/Subscription ownership, Checkout claims,
  Price identity, settlement-Invoice binding, malformed Stripe object shapes, same-second
  ordering ties, annual period verification, reconciliation CAS recovery, and
  cross-account refund/dispute isolation.
- Add migration `004_event_audit_hardening.sql`: retain a redacted Event audit snapshot,
  store the exact signed-body SHA-256 when available, scrub legacy full payloads, and keep
  secrets, PII, hosted URLs, and internal prefetch fields out of PostgreSQL.
- Add append-only migration filenames, advisory-lock serialization, known-file checksum
  verification, packaged migration/catalog resources, and schema readiness. Databases may
  contain later migrations so backward-compatible rolling deploys and rollbacks are not
  blocked by an exact-history equality gate.
- Make the single-payment model explicit with one paid InvoicePayment mapping per Invoice;
  reject pagination, multiple payments, PaymentRecord, out-of-band payment, and overpayment
  shapes without performing a redundant reverse PaymentIntent query.
- Accept Stripe's current expanded default `currency_options` and treat Product/Price
  metadata as conflict detection rather than a second authorization system. Stable lookup
  key, currency, amount, recurring interval, quantity, Customer, and Subscription remain
  authoritative.
- Remove low-value false-positive gates: exact readiness inspection of index/trigger SQL,
  exact Portal benign-feature whitelisting, plan-rank price monotonicity, and duplicate-
  Event payload-hash conflict incidents. Raw request hashes remain audit evidence, not an
  entitlement decision.
- Use PostgreSQL time for distributed claims, leases, reconciliation, and annual workers;
  isolate per-account worker failures and prevent persistent first-page starvation.
- Add fail-closed HTTP input bounds, streamed webhook size limits, no-store responses,
  Origin validation, sanitized auth errors, safer CORS, browser redirect validation,
  build-time production demo rejection, Stripe.js result validation, and reusable browser
  idempotency intents.
- Accept legitimate Stripe-hosted URL fragments in both Gateway and CheckoutCoordinator.
  Speed up browser E2E by aborting only the application's automatic external navigation,
  then explicitly opening the captured test Session after the route is removed.
- Package `plans.toml` and all four migrations in the Wheel, make installed CLI defaults
  independent of the current working directory, and run the Docker image as UID/GID 10001
  with a healthcheck and read-only-root compatibility.
- Verify the `0.2.1` release candidate with 701 local PostgreSQL tests from 710 collected,
  all 9 real Stripe test-mode cases, 102 frontend tests, both real-browser policies through
  Stripe CLI signed forwarding, Python/npm audits with zero known vulnerabilities,
  independent Wheel migration, non-root/read-only Docker runtime, and strict run-owned
  Stripe cleanup. The public promotional video remains the separately reviewed `0.2.0`
  artifact rather than being relabeled as new network evidence.

## 0.2.0 - 2026-08-17

- Add complete `full_period_reset` and `prorated_delta` templates, each with an explicit
  6 × 6 monthly/yearly transition matrix, reference API/UI behavior, and strict paid-
  Invoice funding validation.
- Add migration 003 funding allocations, clawback debt, terminal-closure idempotency,
  exact settlement-Invoice binding, crash-safe applying/Schedule recovery, and bounded
  reconciliation rotation.
- Harden real-browser Checkout navigation, action-target scrolling, upgrade SCA,
  process-secret isolation, payment-failure incident convergence, exact Event identity
  verification, and strict run-owned cleanup.
- Make 3DS completion resilient to the Stripe sandbox rendering the test `Complete`
  button before its challenge listener is attached, while still requiring the challenge
  frame to detach and rejecting any observed ACS HTTP error.
- Add explicit browser webhook transports: the default temporary version-pinned endpoint
  remains the release-evidence mode, while Stripe CLI signed forwarding is available for
  local diagnosis and recording without being mislabeled as endpoint evidence.
- Add a reproducible Playwright/FFmpeg/Tesseract promotional workflow with a mock UI tour,
  real test-mode recording, payment-data masks, original generated music, every-frame
  decode/hash review, privacy OCR checks, poster, and contact sheet.
- Add a server-rendered open-source project landing page, searchable reference plan
  table, visible FAQ, and matching SoftwareApplication/FAQPage JSON-LD.
- Add fail-closed canonical URL and indexing configuration, route-specific noindex,
  robots, sitemap, manifest, generated Open Graph/Twitter cards, and an SEO runbook.
- Centralize the frontend reference catalog so initial pricing HTML is indexable before
  authenticated account hydration.
- Update locked frontend overrides to clear current `nanoid` and `js-yaml` advisories;
  both production-only and complete npm audits report zero known vulnerabilities.
- Verify the 2026-08-17 release candidate with 270 local PostgreSQL tests, all 9 real
  Stripe test-mode cases, 62 frontend tests, both browser policies through Stripe CLI
  signed forwarding, production build, Python/npm audits, strict cleanup, and exact
  three-essential-Event binding. The stronger temporary-endpoint transport retains its
  separate 2026-08-02 evidence and was not recharacterized as a CLI-mode result.

## 0.1.0 - 2026-07-31

- PostgreSQL event inbox and invoice-slot business idempotency.
- Ordered subscription projection with deterministic same-second precedence.
- Monthly and annual subscription credit grants.
- Refund-before-paid, partial-refund, full-refund, and dispute convergence.
- Atomic credit consumption and grant-epoch-safe product refunds.
- Checkout Session single-flight claims.
- Multi-worker annual grants and Stripe-truth reconciliation.
- Dedicated Stripe catalog and Billing Portal bootstrap/verification.
- Authenticated catalog/account/Checkout/Portal/plan-change APIs with fail-closed
  production auth and a local-only demo adapter.
- Six-state plan policy: monthly-origin nominal upgrades start a separately
  funded full-price period; every annual-origin change is period-end.
- Next.js pricing/account/payment-recovery reference with webhook-authoritative
  success polling.
- Disposable PostgreSQL race suite plus six real Stripe test-mode cases covering
  paid/refund projection, full-price monthly upgrade, failed payment/SCA retention,
  annual Schedule creation, and a full Test Clock cross-year renewal lifecycle.
- Opt-in Playwright decline → 3DS → signed-webhook → UI projection gate with a
  temporary version-pinned endpoint, strict ownership cleanup, and separate request,
  signed-payload, and Event API version evidence.
- Verified baseline: 167 local/backend tests, 6 real Stripe test-mode tests, 47
  frontend tests, 1 real-browser lifecycle, and a successful production build/audit.
