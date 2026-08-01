# Changelog

## Unreleased

- Add complete `full_period_reset` and `prorated_delta` templates, each with an explicit
  6 × 6 monthly/yearly transition matrix, reference API/UI behavior, and strict paid-
  Invoice funding validation.
- Add migration 003 funding allocations, clawback debt, terminal-closure idempotency,
  exact settlement-Invoice binding, crash-safe applying/Schedule recovery, and bounded
  reconciliation rotation.
- Harden real-browser Checkout navigation, action-target scrolling, upgrade SCA,
  process-secret isolation, payment-failure incident convergence, exact Event identity
  verification, and strict run-owned cleanup.
- Add a server-rendered open-source project landing page, searchable reference plan
  table, visible FAQ, and matching SoftwareApplication/FAQPage JSON-LD.
- Add fail-closed canonical URL and indexing configuration, route-specific noindex,
  robots, sitemap, manifest, generated Open Graph/Twitter cards, and an SEO runbook.
- Centralize the frontend reference catalog so initial pricing HTML is indexable before
  authenticated account hydration.
- Verify the 2026-08-02 hardened tree with 270 local PostgreSQL tests, 9 real Stripe
  test-mode cases, 62 frontend tests, both real-browser policy gates, production build,
  production-dependency audit, strict cleanup, and zero run-owned Stripe inventory.

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
