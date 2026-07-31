# Changelog

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
- Disposable PostgreSQL race suite; real Stripe test-mode paid/refund, full-price
  monthly upgrade and annual Schedule flows; a one-hour Test Clock readiness
  smoke; and Stripe CLI forwarding guidance.
- Verified baseline: 163 local/backend tests, 4 real Stripe test-mode tests, and
  47 frontend tests plus production build/audit.
