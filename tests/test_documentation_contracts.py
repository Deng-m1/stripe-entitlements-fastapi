from __future__ import annotations

import ast
import re
from pathlib import Path

ROOT = Path(__file__).parents[1]


def _text(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_source_checkout_guides_build_typescript_before_the_first_cli_call() -> None:
    for path in (
        "README.md",
        "typescript/README.md",
        "docs/ADOPTION.md",
        "docs/STRIPE_CLI.md",
        "docs/VERCEL.md",
    ):
        guide = _text(path)
        assert "npx stripe-entitlements" in guide
        assert guide.index("npm run build") < guide.index("npx stripe-entitlements"), path


def test_native_typescript_vercel_uses_the_packaged_catalog_default() -> None:
    guide = _text("docs/VERCEL.md")
    environment_block = (
        guide.split("Set the following server variables for each environment:", maxsplit=1)[1]
        .split("```dotenv", maxsplit=1)[1]
        .split("```", maxsplit=1)[0]
    )

    assert "PLAN_CATALOG_PATH" not in environment_block
    assert "Leave `PLAN_CATALOG_PATH` unset" in guide
    assert "nonexistent `web/plans.toml`" in guide


def test_fastapi_product_route_example_uses_a_verified_identity_dependency() -> None:
    guide = _text("docs/ADOPTION.md")
    section = guide.split(
        "In-process product routes can use the initialized `EntitlementService`", maxsplit=1
    )[1].split("```python", maxsplit=1)[1]
    example = section.split("```", maxsplit=1)[0]

    assert "request.state.billing_owner_external_ref" not in guide
    assert "await personal_auth.authenticate(request)" in example
    assert "validate_owner_external_ref(identity.external_ref)" in example
    assert "identity.external_ref" in example
    assert re.search(r"Depends\(current_billing_identity\)", example)
    ast.parse(example)
