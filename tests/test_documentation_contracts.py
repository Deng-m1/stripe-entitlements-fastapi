from __future__ import annotations

import ast
import re
from pathlib import Path

ROOT = Path(__file__).parents[1]


def _text(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_source_checkout_guides_build_typescript_before_the_first_cli_call() -> None:
    source_sections = {
        "README.md": "For contributors running this source checkout instead:",
        "typescript/README.md": "For contributors working from this source checkout instead:",
        "docs/ADOPTION.md": "## Compose a TypeScript application",
        "docs/STRIPE_CLI.md": "# Native TypeScript / Node operator",
    }
    for path, marker in source_sections.items():
        section = _text(path).split(marker, maxsplit=1)[1]
        assert "npx stripe-entitlements" in section
        assert section.index("npm run build") < section.index("npx stripe-entitlements"), path


def test_registry_install_guides_run_the_packaged_cli_without_a_source_build() -> None:
    package_section = (
        _text("typescript/README.md")
        .split("For a new Node or Next.js project", maxsplit=1)[1]
        .split("For contributors working from this source checkout instead:", maxsplit=1)[0]
    )
    assert "npm install --save-exact @tosea/stripe-entitlements@0.4.0" in package_section
    assert "npx stripe-entitlements --version" in package_section
    assert "cp node_modules/@tosea/stripe-entitlements/.env.example .env" in package_section
    assert "CLI does not load Next.js dotenv files" in package_section
    assert "npm run build" not in package_section

    vercel_section = (
        _text("docs/VERCEL.md")
        .split("## Native TypeScript topology", maxsplit=1)[1]
        .split("## What the checked-in configuration does", maxsplit=1)[0]
    )
    assert "npm install --save-exact @tosea/stripe-entitlements@0.4.0" in vercel_section
    assert "npx stripe-entitlements migrate" in vercel_section
    assert "npm run build" not in vercel_section


def test_adoption_guide_uses_the_packaged_http_subpath_export() -> None:
    guide = _text("docs/ADOPTION.md")
    surface = guide.split("The equivalent TypeScript integration surface is:", maxsplit=1)[1].split(
        "The npm artifact includes", maxsplit=1
    )[0]

    assert "package-root `BillingKernel` and `createBillingRuntime`" in surface
    assert "`@tosea/stripe-entitlements/http` for `createBillingFetchHandler`" in surface
    package_root_line = next(line for line in surface.splitlines() if "package-root" in line)
    assert "createBillingFetchHandler" not in package_root_line


def test_native_typescript_vercel_uses_the_packaged_catalog_default() -> None:
    guide = _text("docs/VERCEL.md")
    environment_block = (
        guide.split("## 3. Add Vercel environment variables", maxsplit=1)[1]
        .split("```dotenv", maxsplit=1)[1]
        .split("```", maxsplit=1)[0]
    )

    assert "PLAN_CATALOG_PATH" not in environment_block
    assert "Leave `PLAN_CATALOG_PATH` unset" in guide
    assert "nonexistent `web/plans.toml`" in guide


def test_vercel_commands_select_the_native_typescript_configuration() -> None:
    guide = _text("docs/VERCEL.md")
    local_section = guide.split("## 5. Run the complete deployment locally", maxsplit=1)[1].split(
        "## 6. Deploy and verify", maxsplit=1
    )[0]
    deploy_section = guide.split("## 6. Deploy and verify", maxsplit=1)[1].split(
        "## Platform boundary", maxsplit=1
    )[0]

    assert "-A vercel.typescript.json dev -L" in local_section
    assert "-A vercel.typescript.json link" in deploy_section
    assert "-A vercel.typescript.json deploy" in deploy_section
    assert "-A vercel.typescript.json deploy --prod" in deploy_section


def test_vercel_staging_is_noindex_and_only_canonical_live_is_indexable() -> None:
    guide = _text("docs/VERCEL.md")
    public_environment_block = (
        guide.split("For a Preview or staging Next.js service", maxsplit=1)[1]
        .split("```dotenv", maxsplit=1)[1]
        .split("```", maxsplit=1)[0]
    )

    assert "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_..." in public_environment_block
    assert "NEXT_PUBLIC_ALLOW_INDEXING=false" in public_environment_block
    assert "NEXT_PUBLIC_ALLOW_INDEXING=true" not in public_environment_block
    assert "Only the canonical live production deployment" in guide
    assert "`NEXT_PUBLIC_ALLOW_INDEXING=true`" in guide


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
