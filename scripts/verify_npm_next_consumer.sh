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
cleanup() {
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

# An allowlisted environment proves the build cannot accidentally depend on local
# billing, Stripe, auth, scheduler, demo, or npm-registry credentials. npm supplies
# only its normal lifecycle variables to the child build; telemetry remains disabled.
(
  cd -- "$project_root"
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
  `npm-next-consumer-contract=clean-install production-build routes=3 resources=${runtimeResources.length}`,
);
JS
)
