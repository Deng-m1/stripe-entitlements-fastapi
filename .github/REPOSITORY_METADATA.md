# GitHub repository metadata

GitHub description:

> PostgreSQL-backed FastAPI + Next.js reference for race-safe Stripe
> subscriptions, credits, refunds, annual grants, Checkout, and server-controlled
> plan changes.

Suggested topics:

- `stripe`
- `fastapi`
- `postgresql`
- `subscriptions`
- `billing`
- `entitlements`
- `webhooks`
- `idempotency`
- `concurrency`
- `nextjs`
- `python`
- `payments`

Suggested repository settings:

- default branch: `main`;
- squash merge with Conventional Commit title;
- require both `Backend` and `Web` CI jobs;
- enable Dependabot and private vulnerability reporting;
- disable force-push/deletion on `main`;
- require one approving review and resolved conversations;
- enable GitHub Releases and Discussions only if they will be maintained.

These values are documentation for repository administrators; committing this
file does not change GitHub's remote description, topics or branch protection.

Example authenticated administrator command:

```bash
gh repo edit FromCSUZhou/stripe-entitlements-fastapi \\
  --description "PostgreSQL-backed FastAPI + Next.js reference for race-safe Stripe subscriptions, credits, refunds, annual grants, Checkout, and server-controlled plan changes." \\
  --add-topic stripe,fastapi,postgresql,subscriptions,billing,entitlements,webhooks,idempotency,concurrency,nextjs,python,payments
```
