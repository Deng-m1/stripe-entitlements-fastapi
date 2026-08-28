## Change

Describe the billing behavior and affected invariant.

## Race and ordering analysis

- Event duplicate behavior:
- Business duplicate behavior:
- Out-of-order permutations:
- Lock acquisition order:
- Rollback/retry behavior:

## Verification

- [ ] `uv run ruff check .`
- [ ] `uv run mypy src`
- [ ] `uv run pytest -m "not real_stripe"`
- [ ] Real Stripe test-mode suite, when payload/API behavior changed
- [ ] `cd web && npm ci && npm audit --omit=dev`
- [ ] `cd web && npm run lint && npm run typecheck && npm test && npm run build`
- [ ] `git diff --check`

## Stripe contract and release impact

- Outbound request API version:
- Webhook Event snapshot API version:
- Migration/catalog impact:
- Auth adapter/API contract impact:
- Manual Stripe scenario required:
- Rollback and reconciliation plan:
