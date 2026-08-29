# GitHub repository metadata

GitHub description:

> Open-source Stripe billing, SaaS entitlements, fractional credits, and one-time credit
> packs with native FastAPI and TypeScript/Next.js backends over PostgreSQL, including
> race-safe webhooks, refunds, SCA, annual grants, and full-period/prorated upgrades.

Suggested topics:

- `stripe`
- `fastapi`
- `postgresql`
- `subscriptions`
- `billing`
- `entitlements`
- `webhooks`
- `idempotency`
- `nextjs`
- `python`
- `typescript`
- `nodejs`
- `saas`
- `stripe-webhooks`
- `stripe-proration`
- `stripe-checkout`
- `stripe-test-clock`
- `credit-packs`
- `credit-ledger`
- `saas-starter`

Suggested repository settings:

- default branch: `main`;
- squash merge with Conventional Commit title;
- require `Backend`, `TypeScript billing core`, `Container`, and `Web` CI jobs;
- enable Dependabot and private vulnerability reporting;
- disable force-push/deletion on `main`;
- require one approving review and resolved conversations;
- enable GitHub Releases and Discussions only if they will be maintained.

These values are documentation for repository administrators; committing this
file does not change GitHub's remote description, topics or branch protection.

Example authenticated administrator command:

```bash
gh repo edit Deng-m1/stripe-entitlements-fastapi \\
  --description "Open-source Stripe billing, SaaS entitlements, credits, and packs with native FastAPI and TypeScript/Next.js backends over PostgreSQL." \\
  --add-topic stripe,fastapi,typescript,nodejs,postgresql,subscriptions,billing,entitlements,webhooks,idempotency,nextjs,python,saas,stripe-webhooks,stripe-proration,stripe-checkout,stripe-test-clock,credit-packs,credit-ledger,saas-starter
```
