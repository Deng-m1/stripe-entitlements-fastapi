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

  it("keeps server secrets and demo auth outside build and start environments", () => {
    for (const block of [
      markedBlock("E2E_FRONTEND_BUILD_ENV"),
      markedBlock("E2E_FRONTEND_START_ENV"),
    ]) {
      expect(block).not.toMatch(
        /STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET|DATABASE_URL|E2E_DATABASE_URL|DEMO_BEARER|whsec_|sk_/,
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
    expect(stripeBrowserSpec.match(/maxRedirects: 0/g)).toHaveLength(2);
    expect(stripeBrowserSpec).toContain("const response = await route.fetch({");
    expect(stripeBrowserSpec).toContain("await route.fulfill({ response });");
    expect(stripeBrowserSpec).not.toMatch(
      /route\.continue\(\{\s*headers: withE2EBackendAuthorization/u,
    );
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
    expect(seed).toContain('Authorization: Bearer $e2e_demo_token');
    expect(seed).toContain("write-cleanup-manifest");
    expect(seed).toContain('manifest.get("account_id") != account_id');
    expect(seed).toContain("stat.S_IMODE(manifest_path.stat().st_mode) != 0o600");
    expect(runner.indexOf(seed)).toBeLessThan(runner.indexOf(playwright));
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
