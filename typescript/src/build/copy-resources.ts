import { chmod, copyFile, cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const distributionDirectory = resolve(scriptDirectory, "..");
const packageDirectory = resolve(distributionDirectory, "..");
const repositoryDirectory = resolve(packageDirectory, "..");
const distributionMigrations = resolve(distributionDirectory, "migrations");

await mkdir(distributionDirectory, { recursive: true });
await rm(distributionMigrations, { recursive: true, force: true });
await cp(resolve(repositoryDirectory, "migrations"), distributionMigrations, {
  recursive: true,
  force: true,
});
await copyFile(
  resolve(repositoryDirectory, "plans.toml"),
  resolve(distributionDirectory, "plans.toml"),
);
await chmod(resolve(distributionDirectory, "node", "bin.js"), 0o755);
