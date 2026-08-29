import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const runner = readFileSync(
  resolve(process.cwd(), "../scripts/run_browser_e2e.sh"),
  "utf8",
);
const playwrightConfig = readFileSync(
  resolve(process.cwd(), "playwright.stripe.config.ts"),
  "utf8",
);
const productionHttpsServer = readFileSync(
  resolve(process.cwd(), "scripts/serve-production-https.mjs"),
  "utf8",
);
const stripeBrowserSpec = readFileSync(
  resolve(process.cwd(), "e2e/stripe-checkout.spec.ts"),
  "utf8",
);
const httpApi = readFileSync(resolve(process.cwd(), "lib/http-api.ts"), "utf8");
const stripeVerifier = readFileSync(
  resolve(process.cwd(), "../scripts/e2e_stripe.py"),
  "utf8",
);
const typescriptBrowserHost = readFileSync(
  resolve(process.cwd(), "../typescript/tests/e2e/browser-host.ts"),
  "utf8",
);

function markedBlock(name) {
  const start = `# ${name}_BEGIN`;
  const end = `# ${name}_END`;
  const from = runner.indexOf(start);
  const to = runner.indexOf(end);
  if (from < 0 || to <= from) throw new Error(`missing runner block ${name}`);
  return runner.slice(from, to + end.length);
}

describe("real browser runner frontend boundary", () => {
  it("defaults to Python and rejects every backend name outside the two implementations", () => {
    expect(runner).toContain(
      'e2e_backend_implementation="${E2E_BACKEND_IMPLEMENTATION:-python}"',
    );
    expect(runner).toContain(
      'case "$e2e_backend_implementation" in\n  python|typescript) ;;',
    );
    expect(runner).toContain(
      "E2E_BACKEND_IMPLEMENTATION must be python or typescript",
    );
  });

  it("migrates with the selected implementation and builds the private TypeScript host", () => {
    const migration = markedBlock("E2E_BACKEND_MIGRATION");

    expect(runner).toContain(
      'e2e_typescript_build_dir="$e2e_repo_root/typescript/node_modules/.cache/stripe-entitlements-e2e-$e2e_run_id"',
    );
    expect(runner).toContain('rm -rf -- "$e2e_typescript_build_dir"');
    expect(migration).toContain(
      'if [[ "$e2e_backend_implementation" == "python" ]]',
    );
    expect(migration).toContain("uv run stripe-entitlements migrate");
    expect(migration).toContain("./node_modules/.bin/tsc -p tsconfig.e2e.json");
    expect(migration).toContain(
      'node "$e2e_typescript_build_dir/src/node/bin.js" migrate',
    );
    expect(migration).toContain(
      'cp -R "$e2e_repo_root/migrations" "$e2e_typescript_build_dir/migrations"',
    );
    expect(migration).toContain(
      'cp "$e2e_repo_root/plans.toml" "$e2e_typescript_build_dir/plans.toml"',
    );
  });

  it("starts either backend in an allowlisted environment with the same TLS and identity boundary", () => {
    const start = markedBlock("E2E_BACKEND_START_ENV");
    const typeScriptBranch = start.slice(start.indexOf("\nelse\n"));

    expect(start.match(/exec env -i/g)).toHaveLength(2);
    expect(start).toContain("scripts.browser_e2e_app:create_app");
    expect(typeScriptBranch).toContain(
      'node "$e2e_typescript_build_dir/tests/e2e/browser-host.js"',
    );
    for (const required of [
      "E2E_TLS_KEY_FILE",
      "E2E_TLS_CERT_FILE",
      "E2E_PERSONAL_JWKS_FILE",
      "E2E_JWT_ISSUER",
      "E2E_PERSONAL_JWT_AUDIENCE",
      "E2E_WORKLOAD_JWT_AUDIENCE",
      "E2E_WORKLOAD_SUBJECT",
      "E2E_WORKLOAD_JWT",
      "E2E_EXPECTED_OWNER_EXTERNAL_REF",
    ]) {
      expect(typeScriptBranch).toContain(required);
    }
    expect(typeScriptBranch).toContain('FRONTEND_ORIGINS="$e2e_frontend_url"');
  });

  it("wraps both TypeScript host-only browser routes in the exact frontend CORS boundary", () => {
    expect(typescriptBrowserHost).toContain(
      "const browserApi = createBrowserE2eApiHandler({",
    );
    expect(typescriptBrowserHost).toContain(
      "allowedOrigins: runtime.kernel.origins",
    );
    expect(typescriptBrowserHost).toContain(
      'pathname === "/api/e2e/portal-evidence"',
    );
    expect(typescriptBrowserHost).toContain('pathname === "/api/e2e/jobs"');
    expect(typescriptBrowserHost).toContain(
      '"Access-Control-Allow-Headers": "Authorization, Content-Type"',
    );
    expect(typescriptBrowserHost).toContain(
      '"Access-Control-Allow-Methods": "POST"',
    );
    expect(typescriptBrowserHost).not.toMatch(
      /Access-Control-Allow-Origin["']?\s*[:=]\s*["']\*["']/u,
    );
    expect(typescriptBrowserHost).not.toContain(
      "Access-Control-Allow-Credentials",
    );
    expect(
      typescriptBrowserHost.indexOf("await browserApi(request)"),
    ).toBeLessThan(
      typescriptBrowserHost.indexOf("return runtime.handler(request)"),
    );
  });

  it("runs one backend-neutral Playwright journey without exposing the workload token", () => {
    const playwright = markedBlock("E2E_PLAYWRIGHT_ENV");

    expect(
      playwright.match(/npm --prefix web run test:e2e:stripe/g),
    ).toHaveLength(1);
    expect(playwright).toContain(
      'E2E_BACKEND_IMPLEMENTATION="$e2e_backend_implementation"',
    );
    expect(playwright).not.toContain("E2E_WORKLOAD_JWT");
    expect(playwright).not.toContain("e2e_workload_token");
    expect(stripeBrowserSpec).not.toContain("E2E_BACKEND_IMPLEMENTATION");
  });

  it("refuses a partial full-stack browser evidence environment", () => {
    for (const required of [
      "E2E_BACKEND_IMPLEMENTATION",
      "E2E_PERSONAL_BEARER_TOKEN",
      "E2E_JOB_SUCCESS_KEY",
      "E2E_JOB_FAILURE_KEY",
    ]) {
      expect(playwrightConfig).toMatch(
        new RegExp(`requiredEnvironment\\(\\s*"${required}"`, "u"),
      );
    }
    expect(playwrightConfig).toContain(
      'requiredEnvironment("E2E_FULL_STACK_EVIDENCE", "1")',
    );
    expect(playwrightConfig).toContain(
      'if (!["python", "typescript"].includes(backendImplementation))',
    );
    expect(playwrightConfig).toContain("successJobKey === failureJobKey");
    expect(playwrightConfig).toContain(
      'requiredPrivateDirectory("E2E_WEBHOOK_GATE_STATE_DIR")',
    );
    expect(playwrightConfig).toContain("state.isSymbolicLink()");
    expect(playwrightConfig).toContain("(statSync(path).mode & 0o077) !== 0");
  });

  it("builds and serves the production bundle instead of using next dev", () => {
    const packageBuild = markedBlock("E2E_TYPESCRIPT_PACKAGE_BUILD_ENV");
    const build = markedBlock("E2E_FRONTEND_BUILD_ENV");
    const start = markedBlock("E2E_FRONTEND_START_ENV");

    expect(packageBuild).toContain("exec env -i");
    expect(packageBuild).toContain("npm run build");
    expect(runner.indexOf(packageBuild)).toBeLessThan(runner.indexOf(build));
    expect(build).toContain("exec env -i");
    expect(build).toContain("./node_modules/.bin/next build");
    expect(start).toContain("exec env -i");
    expect(start).toContain("NODE_ENV=production");
    expect(start).toContain("node ./scripts/serve-production-https.mjs");
    expect(runner).not.toMatch(/\.\/node_modules\/\.bin\/next dev\b/);
    expect(runner).not.toMatch(/\.\/node_modules\/\.bin\/next start\b/);
    expect(productionHttpsServer).toContain(
      "next({ dev: false, hostname, port })",
    );
    expect(productionHttpsServer).toContain("createServer(");
    expect(productionHttpsServer).toContain("app.getRequestHandler()");
  });

  it("reasserts editable Checkout identity immediately before every payment submit", () => {
    expect(stripeBrowserSpec).toMatch(
      /async function submitCheckout\(page: Page\): Promise<void> \{[\s\S]*?await fillCheckoutIdentity\(page\);[\s\S]*?await submit\.click\(\);/u,
    );
  });

  it("keeps server secrets and signed auth outside build and start environments", () => {
    for (const block of [
      markedBlock("E2E_TYPESCRIPT_PACKAGE_BUILD_ENV"),
      markedBlock("E2E_FRONTEND_BUILD_ENV"),
      markedBlock("E2E_FRONTEND_START_ENV"),
    ]) {
      expect(block).not.toMatch(
        /STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET|DATABASE_URL|E2E_DATABASE_URL|PERSONAL_BEARER|WORKLOAD_JWT|DEMO_BEARER|whsec_|sk_/,
      );
    }
    expect(runner).not.toContain("NEXT_PUBLIC_DEMO_BEARER_TOKEN");
  });

  it("enables route auth only in the explicit non-indexable loopback build", () => {
    for (const block of [
      markedBlock("E2E_FRONTEND_BUILD_ENV"),
      markedBlock("E2E_FRONTEND_START_ENV"),
    ]) {
      expect(block).toContain("NODE_ENV=production");
      expect(block).toContain("NEXT_PUBLIC_BILLING_API_MODE=http");
      expect(block).toContain(
        'NEXT_PUBLIC_BILLING_API_BASE_URL="$e2e_backend_url"',
      );
      expect(block).toContain("NEXT_PUBLIC_ALLOW_INDEXING=false");
      expect(block).toContain("E2E_ALLOW_PRODUCTION_ROUTE_AUTH=1");
    }
  });

  it("trusts the loopback CA only in Playwright's Node route-fetch process", () => {
    const build = markedBlock("E2E_FRONTEND_BUILD_ENV");
    const start = markedBlock("E2E_FRONTEND_START_ENV");
    const playwright = markedBlock("E2E_PLAYWRIGHT_ENV");

    expect(playwright).toContain('NODE_EXTRA_CA_CERTS="$e2e_loopback_cert"');
    expect(build).not.toContain("NODE_EXTRA_CA_CERTS");
    expect(start).not.toContain("NODE_EXTRA_CA_CERTS");
  });

  it("uses one ephemeral HTTPS identity for both loopback origins", () => {
    expect(runner).toContain(
      'e2e_backend_url="https://127.0.0.1:${e2e_backend_port}"',
    );
    expect(runner).toContain(
      'e2e_frontend_url="https://127.0.0.1:${e2e_frontend_port}"',
    );
    expect(runner).toContain('--ssl-keyfile "$e2e_loopback_key"');
    expect(runner).toContain('E2E_HTTPS_KEY_FILE="$e2e_loopback_key"');
    expect(runner).toContain("--skip-verify");
  });

  it("pins only the runner-owned certificate instead of disabling browser TLS checks", () => {
    expect(runner).toContain("openssl dgst -sha256 -binary");
    expect(runner).toContain('E2E_LOOPBACK_TLS_SPKI="$e2e_loopback_spki"');
    expect(playwrightConfig).toContain(
      "--ignore-certificate-errors-spki-list=",
    );
    expect(playwrightConfig).not.toContain("ignoreHTTPSErrors");
    expect(playwrightConfig).not.toMatch(
      /--ignore-certificate-errors(?:[\s"'`]|$)/u,
    );
  });

  it("never forwards the injected authorization across an HTTP redirect", () => {
    expect(stripeBrowserSpec.match(/maxRedirects: 0/g)).toHaveLength(3);
    expect(stripeBrowserSpec).toContain("const response = await route.fetch({");
    expect(stripeBrowserSpec).toContain("await route.fulfill({ response });");
    expect(stripeBrowserSpec).not.toMatch(
      /route\.continue\(\{\s*headers: withE2EBackendAuthorization/u,
    );
  });

  it("requires test mode on every attested backend browser mutation", () => {
    const backendAuthentication = stripeBrowserSpec.slice(
      stripeBrowserSpec.indexOf("async function installBackendAuthentication"),
      stripeBrowserSpec.indexOf("async function browserBackendPost"),
    );
    const checkoutCapture = stripeBrowserSpec.slice(
      stripeBrowserSpec.indexOf("async function prepareCheckoutCapture"),
      stripeBrowserSpec.indexOf("async function preparePortalCapture"),
    );
    const portalCapture = stripeBrowserSpec.slice(
      stripeBrowserSpec.indexOf("async function preparePortalCapture"),
      stripeBrowserSpec.indexOf("function assertTestModePortal"),
    );

    expect(backendAuthentication).toContain('request.method() === "POST"');
    expect(backendAuthentication).toContain(
      '"x-stripe-mode-requirement": "test"',
    );
    expect(backendAuthentication).not.toContain("if (!token) return");
    expect(checkoutCapture).toContain('"x-stripe-mode-requirement": "test"');
    expect(portalCapture).toContain('"x-stripe-mode-requirement": "test"');
    for (const mutationPath of [
      "/api/checkout",
      "/api/credit-packs/checkout",
      "/api/billing/portal",
      "/api/billing/change/preview",
      "/api/billing/change/confirm",
    ]) {
      expect(httpApi).toContain(`"${mutationPath}"`);
    }
  });

  it("delivers each Checkout response and aborts its automatic navigation before releasing", () => {
    const checkoutCapture = stripeBrowserSpec.slice(
      stripeBrowserSpec.indexOf("async function prepareCheckoutCapture"),
      stripeBrowserSpec.indexOf("async function preparePortalCapture"),
    );

    expect(checkoutCapture).toContain(
      "const capture = new E2ENavigationCapture<CheckoutRedirect>();",
    );
    expect(checkoutCapture).toContain(
      "capture.publishAfterFulfill(capturedRedirect, () =>",
    );
    expect(checkoutCapture).toContain("capture.markNavigationAborted()");
    expect(checkoutCapture).toContain("capture.readyValue()");
    expect(checkoutCapture).toContain("capture.assertReleasable()");
    expect(
      checkoutCapture.indexOf('await route.abort("blockedbyclient")'),
    ).toBeLessThan(checkoutCapture.indexOf("capture.markNavigationAborted()"));
    expect(
      stripeBrowserSpec.match(
        /const capture = await prepareCheckoutCapture\(/gu,
      ),
    ).toHaveLength(2);
    expect(
      stripeBrowserSpec.match(
        /const redirect = await capture\.wait\(\);\s+await capture\.release\(\);/gu,
      ),
    ).toHaveLength(3);
    expect(stripeBrowserSpec).toContain('"/api/credit-packs/checkout"');
  });

  it("delivers the Portal response and aborts its automatic navigation before releasing evidence work", () => {
    const portalCapture = stripeBrowserSpec.slice(
      stripeBrowserSpec.indexOf("async function preparePortalCapture"),
      stripeBrowserSpec.indexOf("function assertTestModePortal"),
    );
    const portalJourney = stripeBrowserSpec.slice(
      stripeBrowserSpec.indexOf(
        'test.step("open the owner-bound real Stripe Portal and return to account"',
      ),
      stripeBrowserSpec.indexOf(
        'test.step("a user-triggered product Job charges through signed workload auth"',
      ),
    );
    const evidenceSection = portalJourney.slice(
      portalJourney.indexOf("if (fullStackEvidence)"),
      portalJourney.indexOf("await openHostedPortal"),
    );

    expect(portalCapture).toContain(
      "capture.publishAfterFulfill(parsedRedirect, () =>",
    );
    expect(portalCapture).toContain("capture.markNavigationAborted()");
    expect(portalCapture).toContain("capture.assertReleasable()");
    expect(
      portalCapture.indexOf('await route.abort("blockedbyclient")'),
    ).toBeLessThan(portalCapture.indexOf("capture.markNavigationAborted()"));
    expect(evidenceSection).toContain(
      'await accountPage.goto(frontendUrl(baseURL, "/account"), {',
    );
    expect(evidenceSection).toContain(
      "expect(new URL(accountPage.url()).origin).toBe(new URL(baseURL).origin)",
    );
    expect(evidenceSection.indexOf("accountPage.goto")).toBeLessThan(
      evidenceSection.indexOf('"/api/e2e/portal-evidence"'),
    );
  });

  it("handles Stripe Sandbox payment-method and agent-disclosure gates explicitly", () => {
    const packCheckout = stripeBrowserSpec.slice(
      stripeBrowserSpec.indexOf("async function submitCreditPackCheckout"),
      stripeBrowserSpec.indexOf("async function hasVisibleTextAcrossFrames"),
    );
    expect(stripeBrowserSpec).toContain(
      'getByRole("radio", { name: /^Card$/i })',
    );
    expect(stripeBrowserSpec).toContain(
      'getByRole("button", { name: /^Pay with card$/i })',
    );
    expect(stripeBrowserSpec).toContain(
      "card.evaluate((element: HTMLInputElement) => element.click())",
    );
    expect(stripeBrowserSpec).toContain('await card.press("Space")');
    expect(stripeBrowserSpec).toContain(
      "/I am an AI agent acting on behalf of someone else/i",
    );
    expect(stripeBrowserSpec).toContain(
      "/I am an AI agent and have followed the instructions above/i",
    );
    expect(stripeBrowserSpec).toContain(
      "await selectCardPaymentMethodIfPresented(page)",
    );
    expect(
      packCheckout.indexOf("await acknowledgeAgentAutomation(page)"),
    ).toBeLessThan(
      packCheckout.indexOf("await selectCardPaymentMethodIfPresented(page)"),
    );
  });

  it("proves the decline and 3DS attempts stay on one Checkout Session", () => {
    expect(stripeBrowserSpec).toContain('let initialCheckoutSessionId = ""');
    expect(stripeBrowserSpec).toContain(
      "expect(checkoutSessionId(page.url())).toBe(redirectSessionId)",
    );
    expect(
      stripeBrowserSpec.match(
        /expect\(checkoutSessionId\(page\.url\(\)\)\)\.toBe\(initialCheckoutSessionId\)/g,
      ),
    ).toHaveLength(2);
  });

  it("does not print the verified pack Checkout Session identity", () => {
    expect(stripeVerifier).toContain("pack_session_verified=true");
    expect(stripeVerifier).not.toContain("session={pack_session_id}");
  });

  it("creates a unique artifact child without deleting the configured root", () => {
    expect(runner).toContain('e2e_output_root="${E2E_OUTPUT_DIR:-');
    expect(runner).toContain('mktemp -d -- "$e2e_output_root/run-');
    expect(runner).not.toContain('rm -rf "$e2e_output_dir"');
    expect(runner).not.toContain('rm -rf "$e2e_output_root"');
  });

  it("bounds every runner HTTP call so readiness loops cannot hang", () => {
    expect(runner).toContain(
      'command curl --connect-timeout 2 --max-time 5 "$@"',
    );
    expect(runner).not.toMatch(/^\s*curl\b/gmu);
    for (const target of [
      '"${e2e_gate_url}/health"',
      '"${e2e_tunnel_url}/health"',
      '"${e2e_backend_url}/health"',
      '"${e2e_gate_url}/ready"',
      '"${e2e_tunnel_url}/ready"',
      '"${e2e_frontend_url}/pricing"',
    ]) {
      expect(runner).toMatch(
        new RegExp(
          `e2e_bounded_curl[^\\n]*(?:\\\\\\n[^\\n]*)?${target.replace(/[${}]/gu, "\\$&")}`,
          "u",
        ),
      );
    }
  });

  it("writes a secret-free, self-identifying success evidence document", () => {
    const evidencePython = markedBlock("E2E_SUCCESS_EVIDENCE_PY");
    const cleanup = runner.slice(
      runner.indexOf("e2e_cleanup()"),
      runner.indexOf("trap 'e2e_cleanup $?'"),
    );
    const directory = mkdtempSync(join(tmpdir(), "stripe-e2e-evidence-"));
    const output = join(directory, "evidence.json");

    try {
      execFileSync("python", ["-c", evidencePython], {
        env: {
          PATH: process.env.PATH,
          E2E_EVIDENCE_OUTPUT: output,
          E2E_EVIDENCE_RUN_ID: "20260829120000-42",
          E2E_EVIDENCE_COMMIT_SHA: "a".repeat(40),
          E2E_EVIDENCE_GIT_DIRTY: "1",
          E2E_EVIDENCE_BACKEND: "typescript",
          E2E_EVIDENCE_POLICY: "prorated_delta",
          E2E_EVIDENCE_TRANSPORT: "stripe_cli",
          E2E_EVIDENCE_REQUEST_VERSION: "2026-06-24.dahlia",
          E2E_EVIDENCE_EVENT_VERSION: "2026-06-24.dahlia",
        },
        stdio: "pipe",
      });
      const evidence = JSON.parse(readFileSync(output, "utf8"));
      expect(evidence).toEqual({
        schema_version: 1,
        run_id: "20260829120000-42",
        source: { commit_sha: "a".repeat(40), dirty: true },
        backend_implementation: "typescript",
        transition_policy: "prorated_delta",
        webhook_transport: "stripe_cli",
        stripe_api_versions: {
          request: "2026-06-24.dahlia",
          event: "2026-06-24.dahlia",
        },
        verification: {
          browser_e2e: "passed",
          database_verifier: "passed",
          cleanup: "passed",
        },
      });
      expect(statSync(output).mode & 0o777).toBe(0o600);
      expect(readFileSync(output, "utf8")).not.toMatch(
        /(?:sk|rk)_(?:test|live)_|whsec_|eyJ[A-Za-z0-9_-]{10,}\./u,
      );
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }

    expect(cleanup).toContain("e2e_write_success_evidence");
    expect(cleanup).toContain('"$e2e_browser_verified" -ne 1');
    expect(cleanup).toContain('"$e2e_database_verified" -ne 1');
    expect(cleanup.indexOf("e2e_write_success_evidence")).toBeLessThan(
      cleanup.lastIndexOf('e2e_sanitize_evidence_tree "$e2e_output_dir"'),
    );
    expect(runner.indexOf("verify-database")).toBeLessThan(
      runner.indexOf("e2e_database_verified=1"),
    );
    const evidenceWriter = runner.slice(
      runner.indexOf("e2e_write_success_evidence()"),
      runner.indexOf("e2e_stop_pid()"),
    );
    expect(evidenceWriter).toContain("env -i");
    expect(evidenceWriter).not.toMatch(
      /STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET|DATABASE_URL|PERSONAL_BEARER|WORKLOAD_JWT/u,
    );
  });

  it("reports success only from cleanup after final database verification", () => {
    expect(runner.match(/E2E passed/g)).toHaveLength(1);
    const cleanup = runner.slice(
      runner.indexOf("e2e_cleanup()"),
      runner.indexOf("trap 'e2e_cleanup $?'"),
    );
    expect(cleanup).toContain('"$e2e_run_completed" -ne 1');
    expect(cleanup).toContain("E2E passed");
    expect(runner.indexOf("verify-database")).toBeLessThan(
      runner.indexOf("e2e_run_completed=1", runner.indexOf("verify-database")),
    );
  });

  it("seeds a private recovery identity before any browser payment can start", () => {
    const seed = markedBlock("E2E_CLEANUP_MANIFEST_SEED");
    const playwright = markedBlock("E2E_PLAYWRIGHT_ENV");

    expect(seed).toContain('"${e2e_backend_url}/api/account"');
    expect(seed).toContain("Authorization: Bearer $e2e_personal_token");
    expect(seed).toContain("write-cleanup-manifest");
    expect(seed).toContain('manifest.get("account_id") != account_id');
    expect(seed).toContain(
      "stat.S_IMODE(manifest_path.stat().st_mode) != 0o600",
    );
    expect(runner.indexOf(seed)).toBeLessThan(runner.indexOf(playwright));
  });

  it("uses the Personal JWT/JWKS host and keeps workload credentials server-side", () => {
    const playwright = markedBlock("E2E_PLAYWRIGHT_ENV");

    expect(runner).toContain("scripts.browser_e2e_app:create_app");
    expect(runner).toContain("create-auth-fixture");
    expect(runner).toContain("E2E_PERSONAL_JWKS_FILE");
    expect(runner).toContain("E2E_WORKLOAD_JWT");
    expect(playwright).toContain(
      'E2E_PERSONAL_BEARER_TOKEN="$e2e_personal_token"',
    );
    expect(playwright).toContain("exec env -i");
    expect(playwright).not.toContain("E2E_WORKLOAD_JWT");
    expect(playwright).not.toContain("e2e_workload_token");
    expect(runner).not.toContain("APP_ENV=development");
    expect(runner).not.toContain("DEMO_BEARER_TOKEN=");
  });

  it("does not retain authenticated request traces and scans all retained evidence", () => {
    const cleanup = runner.slice(
      runner.indexOf("e2e_cleanup()"),
      runner.indexOf("trap 'e2e_cleanup $?'"),
    );

    expect(playwrightConfig).toContain('trace: "off"');
    expect(playwrightConfig).toContain(
      'const outputDir = resolve(artifactRoot, "results")',
    );
    expect(playwrightConfig).toContain(
      'outputFolder: resolve(artifactRoot, "html-report")',
    );
    expect(runner).toContain("e2e_sanitize_evidence_tree()");
    expect(cleanup).toContain('e2e_sanitize_evidence_tree "$e2e_tmp_dir"');
    expect(cleanup).toContain('e2e_sanitize_evidence_tree "$e2e_output_dir"');
    expect(cleanup).toContain('"$e2e_auth_state" "$e2e_jwks_state"');
    expect(cleanup).toContain('"$e2e_loopback_key"');
    expect(cleanup).toContain('"$e2e_cloudflared_config"');
    expect(cleanup).toContain("retained evidence did not pass the secret scan");
  });

  it("isolates Quick Tunnel from user config and preflights it before Endpoint creation", () => {
    const preflight = markedBlock("E2E_ENDPOINT_TUNNEL_PREFLIGHT");
    const preflightStart = runner.indexOf(
      "# E2E_ENDPOINT_TUNNEL_PREFLIGHT_BEGIN",
    );
    const endpointCreate = runner.indexOf(
      "e2e_webhook_create_started=1",
      preflightStart,
    );
    const backendReady = runner.indexOf(
      'e2e_bounded_curl -fsS "${e2e_tunnel_url}/ready"',
      endpointCreate,
    );
    const accountSeed = runner.indexOf("# E2E_CLEANUP_MANIFEST_SEED_BEGIN");

    expect(runner).toContain('path.write_text("{}\\n", encoding="utf-8")');
    expect(runner).toContain("path.chmod(0o600)");
    expect(runner).toContain('--config "$e2e_cloudflared_config"');
    expect(preflight).toContain(
      'e2e_bounded_curl -fsS "${e2e_tunnel_url}/health"',
    );
    expect(preflight).not.toContain("create-webhook");
    expect(preflightStart).toBeLessThan(endpointCreate);
    expect(endpointCreate).toBeLessThan(backendReady);
    expect(backendReady).toBeLessThan(accountSeed);
  });

  it("never overwrites a seeded recovery identity when the database is unavailable", () => {
    const cleanup = runner.slice(
      runner.indexOf("e2e_cleanup()"),
      runner.indexOf("trap 'e2e_cleanup $?'"),
    );

    expect(cleanup).toContain(
      '[[ ! -e "$e2e_cleanup_manifest" && ! -L "$e2e_cleanup_manifest" ]]',
    );
    expect(cleanup).toContain(
      "preserving the previously seeded cleanup manifest",
    );
  });
});
