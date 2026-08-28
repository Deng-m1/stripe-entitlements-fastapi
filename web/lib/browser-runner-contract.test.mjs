import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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
const stripeVerifier = readFileSync(
  resolve(process.cwd(), "../scripts/e2e_stripe.py"),
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
  it("builds and serves the production bundle instead of using next dev", () => {
    const build = markedBlock("E2E_FRONTEND_BUILD_ENV");
    const start = markedBlock("E2E_FRONTEND_START_ENV");

    expect(build).toContain("exec env -i");
    expect(build).toContain("./node_modules/.bin/next build");
    expect(start).toContain("exec env -i");
    expect(start).toContain("NODE_ENV=production");
    expect(start).toContain("node ./scripts/serve-production-https.mjs");
    expect(runner).not.toMatch(/\.\/node_modules\/\.bin\/next dev\b/);
    expect(runner).not.toMatch(/\.\/node_modules\/\.bin\/next start\b/);
    expect(productionHttpsServer).toContain("next({ dev: false, hostname, port })");
    expect(productionHttpsServer).toContain("createServer(");
    expect(productionHttpsServer).toContain("app.getRequestHandler()");
  });

  it("keeps server secrets and signed auth outside build and start environments", () => {
    for (const block of [
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
      expect(block).toContain('NEXT_PUBLIC_BILLING_API_BASE_URL="$e2e_backend_url"');
      expect(block).toContain("NEXT_PUBLIC_ALLOW_INDEXING=false");
      expect(block).toContain("E2E_ALLOW_PRODUCTION_ROUTE_AUTH=1");
    }
  });

  it("trusts the loopback CA only in Playwright's Node route-fetch process", () => {
    const build = markedBlock("E2E_FRONTEND_BUILD_ENV");
    const start = markedBlock("E2E_FRONTEND_START_ENV");
    const playwright = markedBlock("E2E_PLAYWRIGHT_ENV");

    expect(playwright).toContain(
      'NODE_EXTRA_CA_CERTS="$e2e_loopback_cert"',
    );
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
    expect(playwrightConfig).toContain("--ignore-certificate-errors-spki-list=");
    expect(playwrightConfig).not.toContain("ignoreHTTPSErrors");
    expect(playwrightConfig).not.toMatch(/--ignore-certificate-errors(?:[\s"'`]|$)/u);
  });

  it("never forwards the injected authorization across an HTTP redirect", () => {
    expect(stripeBrowserSpec.match(/maxRedirects: 0/g)).toHaveLength(3);
    expect(stripeBrowserSpec).toContain("const response = await route.fetch({");
    expect(stripeBrowserSpec).toContain("await route.fulfill({ response });");
    expect(stripeBrowserSpec).not.toMatch(
      /route\.continue\(\{\s*headers: withE2EBackendAuthorization/u,
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
    expect(packCheckout.indexOf("await acknowledgeAgentAutomation(page)")).toBeLessThan(
      packCheckout.indexOf("await selectCardPaymentMethodIfPresented(page)"),
    );
  });

  it("proves the decline and 3DS attempts stay on one Checkout Session", () => {
    expect(stripeBrowserSpec).toContain('let initialCheckoutSessionId = ""');
    expect(stripeBrowserSpec).toContain(
      "expect(checkoutSessionId(page.url())).toBe(redirectSessionId)",
    );
    expect(stripeBrowserSpec.match(
      /expect\(checkoutSessionId\(page\.url\(\)\)\)\.toBe\(initialCheckoutSessionId\)/g,
    )).toHaveLength(2);
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

  it("reports success only from cleanup after final database verification", () => {
    expect(runner.match(/E2E passed/g)).toHaveLength(1);
    const cleanup = runner.slice(
      runner.indexOf("e2e_cleanup()"),
      runner.indexOf("trap 'e2e_cleanup $?'")
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
    expect(seed).toContain('Authorization: Bearer $e2e_personal_token');
    expect(seed).toContain("write-cleanup-manifest");
    expect(seed).toContain('manifest.get("account_id") != account_id');
    expect(seed).toContain("stat.S_IMODE(manifest_path.stat().st_mode) != 0o600");
    expect(runner.indexOf(seed)).toBeLessThan(runner.indexOf(playwright));
  });

  it("uses the Personal JWT/JWKS host and keeps workload credentials server-side", () => {
    const playwright = markedBlock("E2E_PLAYWRIGHT_ENV");

    expect(runner).toContain("scripts.browser_e2e_app:create_app");
    expect(runner).toContain("create-auth-fixture");
    expect(runner).toContain("E2E_PERSONAL_JWKS_FILE");
    expect(runner).toContain("E2E_WORKLOAD_JWT");
    expect(playwright).toContain('E2E_PERSONAL_BEARER_TOKEN="$e2e_personal_token"');
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
      'curl -fsS "${e2e_tunnel_url}/ready"',
      endpointCreate,
    );
    const accountSeed = runner.indexOf("# E2E_CLEANUP_MANIFEST_SEED_BEGIN");

    expect(runner).toContain('path.write_text("{}\\n", encoding="utf-8")');
    expect(runner).toContain("path.chmod(0o600)");
    expect(runner).toContain('--config "$e2e_cloudflared_config"');
    expect(preflight).toContain('curl -fsS "${e2e_tunnel_url}/health"');
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
    expect(cleanup).toContain("preserving the previously seeded cleanup manifest");
  });
});
