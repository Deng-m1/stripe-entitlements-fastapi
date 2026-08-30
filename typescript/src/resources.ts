import { accessSync, constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function firstReadable(
  candidates: readonly string[],
  description: string,
): string {
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.R_OK);
      return candidate;
    } catch {
      // Continue through packaged and source-checkout locations.
    }
  }
  throw new Error(`the bundled ${description} is unavailable`);
}

/** Locate the canonical migration bundle in a source checkout or packed npm artifact. */
export function defaultMigrationDirectory(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  return firstReadable(
    [
      resolve(moduleDirectory, "migrations"),
      resolve(moduleDirectory, "../migrations"),
      resolve(moduleDirectory, "../../migrations"),
    ],
    "migration directory",
  );
}

/** Locate the canonical plan catalog in a source checkout or packed npm artifact. */
export function defaultPlanCatalogPath(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  return firstReadable(
    [
      resolve(moduleDirectory, "plans.toml"),
      resolve(moduleDirectory, "../plans.toml"),
      resolve(moduleDirectory, "../../plans.toml"),
    ],
    "plan catalog",
  );
}
