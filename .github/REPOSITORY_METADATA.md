# GitHub repository metadata

GitHub description:

> Open-source Stripe subscription billing and entitlements template for FastAPI,
> PostgreSQL, and Next.js with two complete full-period/prorated upgrade policies,
> race-safe webhooks, annual grants, refunds, SCA, and Test Clock gates.

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
- `saas`
- `stripe-webhooks`
- `subscription-management`
- `stripe-proration`
- `payment-integration`
- `stripe-checkout`
- `stripe-test-clock`

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
  --description "Open-source Stripe billing and entitlements for FastAPI/PostgreSQL with two complete full-period/prorated upgrade policies and race-safe webhooks." \\
  --add-topic stripe,fastapi,postgresql,subscriptions,billing,entitlements,webhooks,idempotency,concurrency,nextjs,python,payments,saas,stripe-webhooks,subscription-management,stripe-proration,payment-integration,stripe-checkout,stripe-test-clock
```
