from __future__ import annotations

import ast
import re
from pathlib import Path

ROOT = Path(__file__).parents[1]


def _text(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_root_readmes_offer_a_symmetric_language_switch_and_core_guidance() -> None:
    english = _text("README.md")
    chinese = _text("README.zh-CN.md")

    assert "**English** | [简体中文](README.zh-CN.md)" in english.splitlines()[:8]
    assert "[English](README.md) | **简体中文**" in chinese.splitlines()[:8]

    for anchor in (
        "choose-runtime",
        "choose-subscription-flow",
        "implemented-scope",
        "plan-catalog",
        "credit-packs",
        "plan-transitions",
        "correctness-model",
        "vercel-deployment",
        "ai-builders",
        "quick-start",
        "adoption",
        "verification",
        "migrations",
        "repository-map",
        "faq",
    ):
        assert f'<a id="{anchor}"></a>' in chinese
        assert f"](#{anchor})" in chinese

    assert '<a id="start-here"></a>' in chinese
    assert '"/README.zh-CN.md"' in _text("pyproject.toml")

    for contract in (
        "src/stripe_entitlements/",
        "typescript/src/",
        "typescript/src/next/",
        "web/app/",
        "full_period_reset",
        "prorated_delta",
        "STRIPE_WEBHOOK_API_VERSION",
        "PostgreSQL 17 或 18",
        "docs/DEPLOYMENT.md",
        "docs/ADOPTION.md",
        "docs/AI_BUILDERS.md",
        "scripts/run_browser_e2e.sh",
        "不宣称验证了生产 webhook payload",
    ):
        assert contract in chinese


def test_agent_guide_requires_dual_runtime_discovery_before_architecture_claims() -> None:
    guide = _text("AGENTS.md")
    readme_entry = _text("README.md").split("## Contents", maxsplit=1)[0]

    for path in (
        "src/stripe_entitlements/",
        "typescript/src/",
        "typescript/src/next/",
        "web/app/",
    ):
        assert path in guide
        assert path in readme_entry

    assert "independent native TypeScript/Node billing backend" in guide
    assert "must not be\nused to classify the whole project as Python-only" in guide
    assert "npm run check" in guide
    assert "npm run build" in guide


def test_source_checkout_guides_build_typescript_before_the_first_cli_call() -> None:
    source_sections = {
        "README.md": "For contributors running this source checkout instead:",
        "typescript/README.md": "For contributors working from this source checkout instead:",
        "docs/ADOPTION.md": "## Compose a TypeScript application",
        "docs/STRIPE_CLI.md": "# Native TypeScript / Node operator",
    }
    for path, marker in source_sections.items():
        section = _text(path).split(marker, maxsplit=1)[1]
        assert "npx --no-install stripe-entitlements" in section
        assert section.index("npm run build") < section.index(
            "npx --no-install stripe-entitlements"
        ), path


def test_unpublished_candidate_guides_use_source_or_local_tarball() -> None:
    package_guide = _text("typescript/README.md")
    assert "there is no `v0.4.0` tag or public npm package yet" in package_guide
    assert "@tosea/stripe-entitlements: file:../typescript" in package_guide
    assert "npm pack --pack-destination /path/to/your-next-app/vendor" in package_guide
    assert "./vendor/tosea-stripe-entitlements-0.4.0.tgz" in package_guide
    assert "npx --no-install stripe-entitlements --version" in package_guide

    vercel_section = (
        _text("docs/VERCEL.md")
        .split("## Native TypeScript topology", maxsplit=1)[1]
        .split("## What the checked-in configuration does", maxsplit=1)[0]
    )
    assert "not published to npm yet" in vercel_section
    assert "./vendor/tosea-stripe-entitlements-0.4.0.tgz" in vercel_section
    assert "npx --no-install stripe-entitlements migrate" in vercel_section

    public_guides = (
        "README.md",
        "typescript/README.md",
        "docs/ADOPTION.md",
        "docs/AI_BUILDERS.md",
        "docs/VERCEL.md",
    )
    for path in public_guides:
        guide = _text(path)
        assert "npm install --save-exact @tosea/stripe-entitlements@0.4.0" not in guide
        assert "npx stripe-entitlements" not in guide
        assert "blob/v0.4.0" not in guide
        assert "tree/v0.4.0" not in guide

    assert re.search(r"\]\(\.\./", package_guide) is None
    assert "](LICENSE)" in package_guide


def test_pinned_git_and_minimum_vendor_paths_are_first_class() -> None:
    adoption = (
        _text("docs/ADOPTION.md")
        .split("## Consume a pinned Git source or vendored copy", maxsplit=1)[1]
        .split("## Contents", maxsplit=1)[0]
    )
    normalized_adoption = " ".join(adoption.split())
    package_guide = _text("typescript/README.md")
    readme = _text("README.md")

    assert (
        "stripe-entitlements-fastapi[auth] @ "
        "git+https://github.com/ToseaAI/stripe-entitlements.git@FULL_COMMIT_SHA" in adoption
    )
    assert '"@tosea/stripe-entitlements": "file:vendor/stripe-entitlements/typescript"' in adoption
    assert "src/stripe_entitlements/" in adoption
    assert "typescript/" in adoption
    assert "├── src/" in adoption
    assert "001_v3_baseline.sql" in adoption
    assert "002_stripe_request_snapshots.sql" in adoption
    assert "plans.toml" in adoption
    assert "change the pinned SHA" in adoption
    assert "replace the entire minimum tree from one commit" in normalized_adoption
    assert "not downloading `@tosea/stripe-entitlements` from the registry" in normalized_adoption
    assert '"prebuild": "npm run billing:build"' in adoption
    assert "npm install --save-exact ./vendor/stripe-entitlements/typescript" in adoption
    assert (
        "git add .gitmodules vendor/stripe-entitlements package.json package-lock.json" in adoption
    )

    assert "### Use a pinned Git checkout or vendored source" in package_guide
    assert "file:vendor/stripe-entitlements/typescript" in package_guide
    assert "do not put the repository root Git URL directly" in package_guide
    assert "npm install --save-exact ./vendor/stripe-entitlements/typescript" in package_guide
    assert (
        "git add .gitmodules vendor/stripe-entitlements package.json package-lock.json"
        in package_guide
    )
    assert "pinned Git and minimum vendoring guide" in readme
    for guide in (adoption, package_guide):
        assert '"billing:build"' in guide
        assert '"prebuild": "npm run billing:build"' in guide
        assert "npm --prefix vendor/stripe-entitlements/typescript run build" in guide
        assert "npm ci" in guide
    for path in (
        "pyproject.toml",
        "plans.toml",
        "migrations/001_v3_baseline.sql",
        "migrations/002_stripe_request_snapshots.sql",
        "src/stripe_entitlements/py.typed",
        "typescript/package.json",
        "typescript/package-lock.json",
        "typescript/tsconfig.json",
        "typescript/tsconfig.build.json",
        "typescript/src/build/copy-resources.ts",
    ):
        assert (ROOT / path).exists(), path


def test_postgresql_major_version_is_not_confused_with_schema_initialization() -> None:
    for path in ("README.md", "typescript/README.md", "docs/ADOPTION.md", "docs/OPERATIONS.md"):
        guide = _text(path)
        assert "PostgreSQL 17 or 18" in guide

    assert "does **not** upgrade PostgreSQL 17 to PostgreSQL 18" in _text("README.md")
    assert "upgrade the PostgreSQL server from major version 17 to 18" in _text(
        "typescript/README.md"
    )


def test_auth_guides_do_not_require_provider_user_or_tenant_uuids() -> None:
    architecture = _text("docs/ARCHITECTURE.md")
    adoption = _text("docs/ADOPTION.md")
    vercel = _text("docs/VERCEL.md")
    package_guide = _text("typescript/README.md")
    starter = _text("examples/auth_starters/README.md")
    browser_e2e = _text("docs/BROWSER_E2E.md")
    team_schema = _text("examples/auth_starters/team_schema.sql")

    assert "UUID and opaque identity-provider subjects" in architecture
    assert "UUID and opaque organization IDs" in adoption
    assert "UUID and opaque provider subjects" in vercel
    assert "UUID, `user_...`, and `org_...` identifiers" in package_guide
    assert "`nbf` is optional" in starter
    assert "v1:user:user_e2e_<opaque-id>" in browser_e2e
    assert 'id text collate "C" primary key' in team_schema
    assert 'user_id text collate "C"' in team_schema
    assert 'tenant_id text collate "C"' in team_schema

    owner_example = adoption.split("# host/billing_owner.py", maxsplit=1)[1].split(
        "```", maxsplit=1
    )[0]
    assert "id: str" in owner_example
    assert "from uuid import UUID" not in owner_example

    assert "verified UUID `sub`" not in package_guide
    assert "canonical tenant UUID" not in architecture
    assert "canonical, non-zero UUID `sub`" not in starter


def test_reference_tier_counts_are_not_documented_as_parser_invariants() -> None:
    readme = _text("README.md")
    architecture = _text("docs/ARCHITECTURE.md")

    assert "any non-empty set of stable plan keys" in readme
    assert "zero or more card-funded one-time USD credit packs" in readme
    assert "bundled reference catalog ships three" in readme
    assert "those counts are examples, not parser\ninvariants" in architecture


def test_catalog_sync_commands_match_the_selected_source_runtime() -> None:
    readme_catalog = (
        _text("README.md")
        .split("## Plan catalog", maxsplit=1)[1]
        .split("## One-time credit packs", maxsplit=1)[0]
    )
    ai_typescript = (
        _text("docs/AI_BUILDERS.md")
        .split("## v0 + Next.js", maxsplit=1)[1]
        .split("## Test the deployed staging site", maxsplit=1)[0]
    )
    vercel_typescript = (
        _text("docs/VERCEL.md")
        .split("## Native TypeScript topology", maxsplit=1)[1]
        .split("## What the checked-in configuration does", maxsplit=1)[0]
    )
    package_source = (
        _text("typescript/README.md")
        .split("### Use the whole repository", maxsplit=1)[1]
        .split("### Install a local tarball", maxsplit=1)[0]
    )

    assert "uv run python scripts/sync_reference_catalog.py --check" in readme_catalog
    assert "npm run sync:catalog -- --check" in readme_catalog
    for section in (ai_typescript, vercel_typescript, package_source):
        assert "npm run sync:catalog" in section
        assert "npm run sync:catalog -- --check" in section
        assert "uv run" not in section

    adoption = _text("docs/ADOPTION.md")
    web_guide = _text("web/README.md")
    for guide in (adoption, web_guide):
        assert "uv run python scripts/sync_reference_catalog.py" in guide
        assert "npm run sync:catalog" in guide


def test_typescript_error_hook_is_server_only_and_responses_stay_sanitized() -> None:
    for guide in (_text("README.md"), _text("typescript/README.md")):
        assert "BillingFetchHandlerOptions.onError" in guide
        assert "original\nserver exception" in guide or "original exception" in guide
        assert "server-only" in guide
        assert "browser-visible state" in guide


def test_changelog_marks_the_candidate_as_unreleased() -> None:
    changelog = _text("CHANGELOG.md")
    assert changelog.startswith("# Changelog\n\n## [Unreleased 0.4.0]\n")


def test_readme_has_a_short_four_path_entrypoint_before_contents() -> None:
    readme = _text("README.md")
    entrypoint = readme.split("## Start here", maxsplit=1)[1].split("## Contents", maxsplit=1)[0]

    assert "Python/FastAPI" in entrypoint
    assert "native Next.js/TypeScript" in entrypoint
    assert "real Stripe test-mode staging" in entrypoint
    assert "UI-only link without Stripe/DB" in entrypoint
    assert "#quick-start" in entrypoint
    assert "typescript/README.md#requirements" in entrypoint
    assert "docs/DEPLOYMENT.md" in entrypoint
    assert "docs/AI_BUILDERS.md#publish-a-ui-only-simulation" in entrypoint


def test_first_deployment_guide_keeps_ai_and_webhook_boundaries_explicit() -> None:
    guide = _text("docs/DEPLOYMENT.md")
    normalized = " ".join(guide.split())

    for choice in (
        "person or one team",
        "Python/FastAPI or TypeScript/Node/Next.js",
        "full_period_reset",
        "prorated_delta",
        "stable staging domain",
        "UI simulation, Stripe test staging",
    ):
        assert choice in normalized

    for event_type in (
        "checkout.session.completed",
        "checkout.session.expired",
        "invoice.paid",
        "invoice.payment_failed",
        "customer.subscription.updated",
        "customer.subscription.deleted",
        "charge.refunded",
        "charge.dispute.created",
        "payment_intent.succeeded",
    ):
        assert event_type in guide

    assert "outputFileTracingIncludes" in guide
    assert "dist/plans.toml" in guide
    assert "dist/migrations/**/*.sql" in guide
    assert "Ignored `.env` and `.env.local` files are local inputs" in guide
    assert "temporary signing secret" in guide
    assert "two phases" in guide
    assert "Registration itself fails" in guide
    assert "host application" in guide.lower()
    assert "Stripe does not grant application access" in guide


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

    builder_guide = _text("docs/AI_BUILDERS.md")
    assert "default `vercel.json` intentionally routes billing to FastAPI" in builder_guide
    assert "select vercel.typescript.json explicitly" in builder_guide


def test_external_browser_guide_does_not_present_web_internals_as_package_api() -> None:
    guide = _text("docs/AI_BUILDERS.md")
    lovable = guide.split("## Lovable + Supabase", maxsplit=1)[1].split(
        "## v0 + Next.js", maxsplit=1
    )[0]
    adoption = _text("docs/ADOPTION.md").split(
        "## Connect or replace the Next.js frontend", maxsplit=1
    )[1]
    example = _text("examples/browser_adapters/vite-billing-client.ts")

    assert "@/lib/" not in lovable
    assert "server-only and currently unpublished" in lovable
    assert "copy the dependency-free" in lovable
    assert "same-origin BFF" in lovable
    assert "vite-billing-client.ts" in lovable
    assert "private source alias, not an\ninstallable package API" in adoption
    assert "vite-billing-client.ts" in adoption
    assert "@/" not in example
    assert "@tosea/stripe-entitlements" not in example
    assert "process.env" not in example
    assert "getAccessToken" in example
    assert '"Idempotency-Key"' in example
    assert "MAXIMUM_ACCESS_TOKEN" not in example
    assert 'baseUrl.pathname !== "/"' not in example
    assert "path.slice(1)" in example


def test_vercel_topology_guides_distinguish_monorepo_and_root_nextjs() -> None:
    builder_guide = _text("docs/AI_BUILDERS.md")
    vercel_guide = _text("docs/VERCEL.md")
    package_guide = _text("typescript/README.md")

    normalized_builder_guide = " ".join(builder_guide.split())
    normalized_vercel_guide = " ".join(vercel_guide.split())
    normalized_package_guide = " ".join(package_guide.split())
    assert "standalone root-level Next.js project" in normalized_builder_guide
    assert "do **not** copy the monorepo Services file" in normalized_builder_guide
    assert "standalone root-level Next.js project must not copy" in normalized_vercel_guide
    assert "standalone root-level Next.js project" in normalized_package_guide
    assert "do not copy it unchanged" in normalized_package_guide
    assert (
        "checked-in default `vercel.json` selects the separate FastAPI" in normalized_package_guide
    )


def test_source_monorepo_invokes_the_typescript_cli_from_its_package_directory() -> None:
    guide = _text("docs/VERCEL.md")
    native = guide.split("## Native TypeScript topology", maxsplit=1)[1].split(
        "## What the checked-in configuration does", maxsplit=1
    )[0]

    assert "cd typescript" in native
    assert native.index("cd typescript") < native.index(
        "npx --no-install stripe-entitlements migrate"
    )
    assert "monorepo root would try to resolve an unpublished" in native

    package_guide = _text("typescript/README.md")
    migration = package_guide.split("## Initialize PostgreSQL", maxsplit=1)[1].split(
        "## Bootstrap Stripe without Python", maxsplit=1
    )[0]
    assert "environment_file=./.env" in migration
    assert "change this to ./.env.local" in migration


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
