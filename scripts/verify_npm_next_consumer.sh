#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: scripts/verify_npm_next_consumer.sh PACKAGE.tgz" >&2
}

if [ "$#" -ne 1 ]; then
  usage
  exit 2
fi

archive_input="$1"
case "$archive_input" in
  *.tgz) ;;
  *)
    echo "npm package archive must use the .tgz extension" >&2
    exit 2
    ;;
esac
if [ ! -f "$archive_input" ] || [ ! -s "$archive_input" ]; then
  echo "npm package archive is missing, empty, or not a regular file" >&2
  exit 2
fi
archive="$(realpath "$archive_input")"

node_version="$(node -p 'process.versions.node')"
node_major="${node_version%%.*}"
case "$node_major" in
  ''|*[!0-9]*)
    echo "cannot determine the Node.js major version" >&2
    exit 2
    ;;
esac
if [ "$node_major" -lt 22 ]; then
  echo "clean Next.js consumer verification requires Node.js 22 or newer" >&2
  exit 2
fi

script_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repository_root="$(cd -- "$script_root/.." && pwd -P)"
fixture_root="$repository_root/tests/npm-next-consumer"
if [ ! -f "$fixture_root/package.json" ] || [ ! -f "$fixture_root/package-lock.json" ]; then
  echo "clean Next.js consumer fixture is incomplete" >&2
  exit 1
fi

scratch_root="$(mktemp -d -t stripe-entitlements-npm-next.XXXXXXXX)"
project_root="$scratch_root/consumer"
postgres_suffix="${scratch_root##*.}"
postgres_container="stripe-entitlements-npm-next-pg-${postgres_suffix}-$$"
postgres_started=0
next_pid=""
cleanup() {
  if [ -n "$next_pid" ]; then
    kill "$next_pid" >/dev/null 2>&1 || true
    for ((attempt = 0; attempt < 50; attempt += 1)); do
      if ! kill -0 "$next_pid" >/dev/null 2>&1; then
        break
      fi
      sleep 0.1
    done
    kill -KILL "$next_pid" >/dev/null 2>&1 || true
    wait "$next_pid" >/dev/null 2>&1 || true
  fi
  if [ "$postgres_started" -eq 1 ]; then
    docker rm --force "$postgres_container" >/dev/null 2>&1 || true
  fi
  rm -rf -- "$scratch_root"
}
trap cleanup EXIT

mkdir -p -- "$project_root"
cp -R -- "$fixture_root/." "$project_root/"
cp -- "$archive" "$project_root/package-under-test.tgz"

(
  cd -- "$project_root"
  npm \
    --userconfig=/dev/null \
    --cache="$scratch_root/npm-cache" \
    --update-notifier=false \
    install \
    --package-lock-only \
    --save-exact \
    --ignore-scripts \
    --no-audit \
    --no-fund \
    ./package-under-test.tgz >/dev/null
  npm \
    --userconfig=/dev/null \
    --cache="$scratch_root/npm-cache" \
    --update-notifier=false \
    ci --ignore-scripts --no-audit --no-fund >/dev/null
)

# Resolve and import the package from the clean project's node_modules. The checks
# reject npm links, source-checkout fallback, a wrong package name, and a missing
# Next.js export before the more expensive production build starts.
(
  cd -- "$project_root"
  env -i PATH="$PATH" node --input-type=module - "$repository_root" <<'JS'
import { lstat, readFile, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isAbsolute, relative, resolve } from "node:path";

const repositoryRoot = await realpath(process.argv[2]);
const projectRoot = await realpath(process.cwd());
const consumerPackageJson = JSON.parse(
  await readFile(resolve(projectRoot, "package.json"), "utf8"),
);
const consumerPackageLock = JSON.parse(
  await readFile(resolve(projectRoot, "package-lock.json"), "utf8"),
);
const archiveSpec = "file:package-under-test.tgz";
if (
  consumerPackageJson.dependencies?.["@tosea/stripe-entitlements"] !==
    archiveSpec ||
  consumerPackageLock.packages?.[""]?.dependencies?.[
    "@tosea/stripe-entitlements"
  ] !== archiveSpec ||
  consumerPackageLock.packages?.[
    "node_modules/@tosea/stripe-entitlements"
  ]?.resolved !== archiveSpec
) {
  throw new Error("clean Next.js consumer lock is not bound to the supplied archive");
}

const installedRootPath = resolve(
  projectRoot,
  "node_modules",
  "@tosea",
  "stripe-entitlements",
);
const installedEntry = await lstat(installedRootPath);
if (installedEntry.isSymbolicLink() || !installedEntry.isDirectory()) {
  throw new Error("clean Next.js consumer installed a linked or invalid package");
}

const installedRoot = await realpath(installedRootPath);
const installedRelative = relative(projectRoot, installedRoot);
if (
  installedRelative === "" ||
  installedRelative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
  installedRelative === ".." ||
  isAbsolute(installedRelative)
) {
  throw new Error("installed npm package escaped the clean consumer project");
}
const repositoryRelative = relative(repositoryRoot, installedRoot);
if (
  repositoryRelative === "" ||
  (!repositoryRelative.startsWith("..") && !isAbsolute(repositoryRelative))
) {
  throw new Error("clean Next.js consumer resolved the package from the source checkout");
}

const packageJson = JSON.parse(
  await readFile(resolve(installedRoot, "package.json"), "utf8"),
);
if (packageJson.name !== "@tosea/stripe-entitlements") {
  throw new Error("installed npm archive exposes an unexpected package name");
}
if (packageJson.dependencies?.["@types/pg"] !== "8.23.1") {
  throw new Error(
    "installed npm archive omits its exact public pg declaration dependency",
  );
}

const nextModulePath = await realpath(
  fileURLToPath(import.meta.resolve("@tosea/stripe-entitlements/next")),
);
const nextRelative = relative(installedRoot, nextModulePath);
if (
  nextRelative === "" ||
  nextRelative === ".." ||
  nextRelative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
  isAbsolute(nextRelative)
) {
  throw new Error("Next.js adapter resolved outside the installed npm archive");
}

const nextAdapter = await import("@tosea/stripe-entitlements/next");
if (typeof nextAdapter.environmentNextBillingRouteHandler !== "function") {
  throw new Error("installed npm archive is missing its Next.js route handler");
}
JS
)

# An allowlisted environment proves the strict package declaration check and build
# cannot accidentally depend on local billing, Stripe, auth, scheduler, demo, or
# npm-registry credentials. npm supplies only its normal lifecycle variables to the
# child processes; telemetry remains disabled.
(
  cd -- "$project_root"
  env -i \
    PATH="$PATH" \
    CI=1 \
    NEXT_TELEMETRY_DISABLED=1 \
    npm_config_cache="$scratch_root/npm-cache" \
    npm_config_update_notifier=false \
    npm_config_userconfig=/dev/null \
    npm run typecheck:package
  env -i \
    PATH="$PATH" \
    CI=1 \
    NEXT_TELEMETRY_DISABLED=1 \
    npm_config_cache="$scratch_root/npm-cache" \
    npm_config_update_notifier=false \
    npm_config_userconfig=/dev/null \
    npm run build
)

if [ ! -s "$project_root/.next/BUILD_ID" ]; then
  echo "clean Next.js consumer did not produce a production BUILD_ID" >&2
  exit 1
fi

(
  cd -- "$project_root"
  env -i PATH="$PATH" node --input-type=module <<'JS'
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, normalize, resolve, sep } from "node:path";

const manifestPath = resolve(".next", "server", "app-paths-manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const expectedRoutes = [
  "/api/[...billing]/route",
  "/webhooks/stripe/route",
  "/health/route",
];
const installedRoot = await realpath(
  resolve("node_modules", "@tosea", "stripe-entitlements"),
);
const distributionRoot = resolve(installedRoot, "dist");
const migrationRoot = resolve(distributionRoot, "migrations");
const migrationFilenames = (await readdir(migrationRoot, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
  .map((entry) => entry.name)
  .sort();
if (migrationFilenames.length === 0) {
  throw new Error("installed npm archive contains no SQL migrations");
}
const runtimeResources = [
  resolve(distributionRoot, "plans.toml"),
  ...migrationFilenames.map((filename) => resolve(migrationRoot, filename)),
];

for (const route of expectedRoutes) {
  const compiledPath = manifest[route];
  const normalizedPath =
    typeof compiledPath === "string" ? normalize(compiledPath) : "";
  if (
    normalizedPath.length === 0 ||
    isAbsolute(normalizedPath) ||
    normalizedPath === ".." ||
    normalizedPath.startsWith(`..${sep}`)
  ) {
    throw new Error(`production build is missing ${JSON.stringify(route)}`);
  }
  const compiledStat = await stat(
    resolve(".next", "server", normalizedPath),
  );
  if (!compiledStat.isFile() || compiledStat.size === 0) {
    throw new Error(`production route is not a non-empty file: ${route}`);
  }

  const tracePath = resolve(
    ".next",
    "server",
    `${normalizedPath}.nft.json`,
  );
  const trace = JSON.parse(await readFile(tracePath, "utf8"));
  if (!Array.isArray(trace.files)) {
    throw new Error(`production route has no output-file trace: ${route}`);
  }
  const tracedFiles = new Set(
    trace.files
      .filter((filename) => typeof filename === "string")
      .map((filename) => resolve(dirname(tracePath), filename)),
  );
  for (const resourcePath of runtimeResources) {
    if (!tracedFiles.has(resourcePath)) {
      throw new Error(
        `production route omitted a packaged runtime resource: ${route}`,
      );
    }
    const resourceStat = await stat(resourcePath);
    if (!resourceStat.isFile() || resourceStat.size === 0) {
      throw new Error("packaged runtime resource is not a non-empty file");
    }
  }
}

const routesManifest = JSON.parse(
  await readFile(resolve(".next", "routes-manifest.json"), "utf8"),
);
const staticPages = new Set(
  Array.isArray(routesManifest.staticRoutes)
    ? routesManifest.staticRoutes.map((route) => route.page)
    : [],
);
const dynamicPages = new Set(
  Array.isArray(routesManifest.dynamicRoutes)
    ? routesManifest.dynamicRoutes.map((route) => route.page)
    : [],
);
if (
  !staticPages.has("/health") ||
  !staticPages.has("/webhooks/stripe") ||
  !dynamicPages.has("/api/[...billing]")
) {
  throw new Error("production route manifest is missing a billing URL");
}

console.log(
  `npm-next-consumer-contract=clean-install declarations=strict production-build routes=3 resources=${runtimeResources.length}`,
);
JS
)

if ! command -v docker >/dev/null 2>&1; then
  echo "clean Next.js runtime verification requires Docker" >&2
  exit 1
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "clean Next.js runtime verification requires curl" >&2
  exit 1
fi

installed_cli="$project_root/node_modules/.bin/stripe-entitlements"
if [ ! -x "$installed_cli" ]; then
  echo "clean Next.js consumer did not install the packaged CLI" >&2
  exit 1
fi

postgres_image="${TEST_POSTGRES_IMAGE:-postgres:17-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73}"
postgres_database="npm_next_consumer_ci"
postgres_password="npm-next-consumer-ci-only"
docker run \
  --detach \
  --name "$postgres_container" \
  --env "POSTGRES_DB=$postgres_database" \
  --env "POSTGRES_PASSWORD=$postgres_password" \
  --publish 127.0.0.1::5432 \
  --tmpfs /var/lib/postgresql/data:rw,nosuid,nodev,size=256m \
  "$postgres_image" >/dev/null
postgres_started=1

postgres_ready=0
for ((attempt = 0; attempt < 240; attempt += 1)); do
  if docker exec "$postgres_container" \
    pg_isready -h 127.0.0.1 -U postgres -d "$postgres_database" \
    >/dev/null 2>&1; then
    postgres_ready=1
    break
  fi
  sleep 0.25
done
if [ "$postgres_ready" -ne 1 ]; then
  echo "disposable PostgreSQL 17 did not become ready" >&2
  exit 1
fi

postgres_version_num="$(
  docker exec "$postgres_container" \
    psql -X -A -t -U postgres -d "$postgres_database" \
    -c 'show server_version_num'
)"
case "$postgres_version_num" in
  17????) ;;
  *)
    echo "clean Next.js runtime verification requires PostgreSQL 17" >&2
    exit 1
    ;;
esac

postgres_binding="$(docker port "$postgres_container" 5432/tcp)"
case "$postgres_binding" in
  127.0.0.1:*) postgres_port="${postgres_binding##*:}" ;;
  *)
    echo "cannot resolve the loopback PostgreSQL port" >&2
    exit 1
    ;;
esac
case "$postgres_port" in
  ''|*[!0-9]*)
    echo "resolved PostgreSQL port is invalid" >&2
    exit 1
    ;;
esac
database_url="postgresql://postgres:${postgres_password}@127.0.0.1:${postgres_port}/${postgres_database}"

# Run the binary installed from the supplied archive, from outside both the source
# checkout and the clean consumer. Migrations are deliberately separate from startup.
migration_output="$(
  cd -- "$scratch_root"
  env -i \
    PATH="$PATH" \
    DATABASE_URL="$database_url" \
    DATABASE_POOL_MIN=0 \
    DATABASE_POOL_MAX=2 \
    "$installed_cli" migrate
)"
if [ "$migration_output" != '{"ok":true,"command":"migrate"}' ]; then
  echo "installed npm package CLI returned an unexpected migration result" >&2
  exit 1
fi

next_port="$(
  env -i PATH="$PATH" node --input-type=module <<'JS'
import { createServer } from "node:net";

const server = createServer();
server.unref();
server.on("error", (error) => {
  throw error;
});
server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("cannot reserve a loopback Next.js port");
  }
  process.stdout.write(String(address.port));
  server.close();
});
JS
)"
case "$next_port" in
  ''|*[!0-9]*)
    echo "resolved Next.js port is invalid" >&2
    exit 1
    ;;
esac

next_origin="http://127.0.0.1:${next_port}"
next_log="$scratch_root/next-production.log"
health_json="$scratch_root/health.json"

# These syntactically valid values are explicit inert placeholders. The smoke calls
# only /health, which performs no Stripe network operation. Constructing the prefixes
# prevents credential-shaped literals from being committed or printed.
stripe_secret_key="$(printf '%s%s' 'sk' '_test_clean_consumer_placeholder_never_sent')"
stripe_webhook_secret="$(printf '%s%s' 'whsec' '_clean_consumer_placeholder_never_used')"

(
  cd -- "$project_root"
  exec env -i \
    PATH="$PATH" \
    CI=1 \
    NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    DATABASE_URL="$database_url" \
    DATABASE_POOL_MIN=0 \
    DATABASE_POOL_MAX=2 \
    STRIPE_SECRET_KEY="$stripe_secret_key" \
    STRIPE_WEBHOOK_SECRET="$stripe_webhook_secret" \
    STRIPE_API_VERSION=2026-06-24.dahlia \
    STRIPE_WEBHOOK_API_VERSION=2026-06-24.dahlia \
    PRODUCT_LINE=clean-consumer-smoke \
    LOOKUP_PREFIX=smoke \
    CHECKOUT_SUCCESS_URL="$next_origin/billing/success" \
    CHECKOUT_CANCEL_URL="$next_origin/pricing" \
    PORTAL_RETURN_URL="$next_origin/account" \
    FRONTEND_ORIGINS="$next_origin" \
    BILLING_TRANSITION_POLICY=full_period_reset \
    BILLING_AUTH_MODE=reject_all \
    APP_ENV=production \
    node ./node_modules/next/dist/bin/next start \
      --hostname 127.0.0.1 \
      --port "$next_port"
) >"$next_log" 2>&1 &
next_pid="$!"

runtime_ready=0
for ((attempt = 0; attempt < 240; attempt += 1)); do
  if ! kill -0 "$next_pid" >/dev/null 2>&1; then
    break
  fi
  if curl \
    --fail \
    --silent \
    --show-error \
    --connect-timeout 1 \
    --max-time 2 \
    --output "$health_json" \
    "$next_origin/health" 2>/dev/null; then
    runtime_ready=1
    break
  fi
  sleep 0.25
done
if [ "$runtime_ready" -ne 1 ]; then
  echo "clean production Next.js runtime did not become healthy" >&2
  exit 1
fi

env -i PATH="$PATH" node --input-type=module - "$health_json" <<'JS'
import { readFile } from "node:fs/promises";

const payload = JSON.parse(await readFile(process.argv[2], "utf8"));
if (
  payload.ok !== true ||
  payload.database !== true ||
  payload.schema !== true ||
  payload.stripe_mode !== "test" ||
  payload.transition_policy !== "full_period_reset"
) {
  throw new Error("clean production Next.js health contract failed");
}
JS

echo "npm-next-consumer-runtime=production-next installed-cli=true postgres=17 health-ok=true database=true schema=true"
