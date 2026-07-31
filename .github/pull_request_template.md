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
- [ ] `git diff --check`
