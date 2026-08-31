# GitHub repository metadata

GitHub description:

> Dual-runtime Stripe billing and SaaS entitlements for TypeScript/Node/Next.js and
> Python/FastAPI, with PostgreSQL credits, Checkout, race-safe webhooks, refunds, SCA,
> annual grants, and full-period or prorated upgrades.

Suggested topics:

- `stripe`
- `billing`
- `entitlements`
- `subscription-management`
- `credit-ledger`
- `credit-packs`
- `stripe-checkout`
- `stripe-webhooks`
- `idempotency`
- `postgresql`
- `python`
- `fastapi`
- `typescript`
- `nodejs`
- `nextjs`
- `nextjs-app-router`
- `ssr`
- `vercel`
- `saas`
- `saas-starter`

Suggested repository settings:

- default branch: `main`;
- squash merge with Conventional Commit title;
- require `Backend`, `TypeScript billing core`, `PostgreSQL 18 compatibility`,
  `Container`, and `Web` CI jobs;
- enable Dependabot and private vulnerability reporting;
- disable force-push/deletion on `main`;
- do not require an external approval for maintainer-authored changes;
- enable GitHub Releases and Discussions only if they will be maintained.

These values are documentation for repository administrators; committing this
file does not change GitHub's remote description, topics or branch protection.

Example authenticated administrator command:

```bash
gh repo edit ToseaAI/stripe-entitlements \\
  --description "Dual-runtime Stripe billing and SaaS entitlements for TypeScript/Node/Next.js and Python/FastAPI, with PostgreSQL credits, Checkout, webhooks, refunds, SCA, annual grants, and full-period or prorated upgrades." \\
  --add-topic stripe,billing,entitlements,subscription-management,credit-ledger,credit-packs,stripe-checkout,stripe-webhooks,idempotency,postgresql,python,fastapi,typescript,nodejs,nextjs,nextjs-app-router,ssr,vercel,saas,saas-starter
```
