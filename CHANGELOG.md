# Changelog

## Unreleased

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
