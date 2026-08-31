import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nextRoot = resolve(projectRoot, ".next");
const manifest = JSON.parse(
  await readFile(resolve(nextRoot, "server", "app-paths-manifest.json"), "utf8"),
);
const packageRoot = await realpath(
  resolve(projectRoot, "node_modules", "@tosea", "stripe-entitlements"),
);
const distributionRoot = resolve(packageRoot, "dist");
const migrationRoot = resolve(distributionRoot, "migrations");
const migrationFiles = (await readdir(migrationRoot, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
  .map((entry) => resolve(migrationRoot, entry.name))
  .sort();
const requiredResources = [
  resolve(distributionRoot, "plans.toml"),
  ...migrationFiles,
];

if (migrationFiles.length === 0) {
  throw new Error("billing package contains no SQL migrations");
}

for (const route of [
  "/api/[...billing]/route",
  "/webhooks/stripe/route",
  "/health/route",
]) {
  const compiledPath = manifest[route];
  if (typeof compiledPath !== "string" || compiledPath.length === 0) {
    throw new Error(`production build is missing ${route}`);
  }
  const tracePath = resolve(nextRoot, "server", `${compiledPath}.nft.json`);
  const trace = JSON.parse(await readFile(tracePath, "utf8"));
  const tracedFiles = new Set(
    trace.files.map((filename) => resolve(dirname(tracePath), filename)),
  );

  for (const resource of requiredResources) {
    if (!tracedFiles.has(resource)) {
      throw new Error(`${route} omitted runtime resource ${resource}`);
    }
    const resourceStat = await stat(resource);
    if (!resourceStat.isFile() || resourceStat.size === 0) {
      throw new Error(`runtime resource is missing or empty: ${resource}`);
    }
  }
}

console.log(
  `verified billing runtime resources in 3 server route traces (${requiredResources.length} files)`,
);
