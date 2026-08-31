import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { PlanCatalog } from "../catalog.js";

export interface PublicReferencePlan {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly currency: string;
  readonly rank: number;
  readonly monthly_credits: string;
  readonly month_usd: number;
  readonly year_usd: number;
  readonly features: readonly string[];
  readonly limits: Readonly<Record<string, number>>;
}

export interface PublicReferenceCreditPack {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly currency: string;
  readonly rank: number;
  readonly credits: string;
  readonly price_usd: number;
  readonly expires_days: number;
}

export interface PublicReferenceCatalog {
  readonly plans: readonly PublicReferencePlan[];
  readonly credit_packs: readonly PublicReferenceCreditPack[];
}

/** Derive the server-rendered public catalog from the validated billing catalog. */
export async function buildPublicReferenceCatalog(
  catalogPath: string,
): Promise<PublicReferenceCatalog> {
  const catalog = await PlanCatalog.fromToml(catalogPath);
  return {
    plans: catalog.ordered().map((plan) => ({
      key: plan.key,
      name: plan.name,
      description: plan.description,
      currency: plan.currency.toUpperCase(),
      rank: plan.rank,
      monthly_credits: plan.monthlyCredits.toString(),
      month_usd: plan.monthUsd,
      year_usd: plan.yearUsd,
      features: [...plan.features],
      limits: { ...plan.limits },
    })),
    credit_packs: catalog.orderedCreditPacks().map((pack) => ({
      key: pack.key,
      name: pack.name,
      description: pack.description,
      currency: pack.currency.toUpperCase(),
      rank: pack.rank,
      credits: pack.credits.toString(),
      price_usd: pack.priceUsd,
      expires_days: pack.expiresDays,
    })),
  };
}

interface SyncOptions {
  readonly catalogPath: string;
  readonly outputPath: string;
  readonly check: boolean;
}

function parseArguments(argv: readonly string[]): SyncOptions {
  let catalogPath = resolve(process.cwd(), "../plans.toml");
  let outputPath = resolve(process.cwd(), "../web/reference-catalog.json");
  let check = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") {
      check = true;
      continue;
    }
    if (argument !== "--catalog" && argument !== "--output") {
      throw new TypeError(
        "usage: sync-reference-catalog [--catalog PATH] [--output PATH] [--check]",
      );
    }
    const value = argv[index + 1];
    if (value === undefined || value.length === 0) {
      throw new TypeError(`${argument} requires a path`);
    }
    index += 1;
    if (argument === "--catalog") catalogPath = resolve(value);
    else outputPath = resolve(value);
  }
  return { catalogPath, outputPath, check };
}

export async function syncPublicReferenceCatalog(
  options: SyncOptions,
): Promise<void> {
  const catalog = await buildPublicReferenceCatalog(options.catalogPath);
  const rendered = `${JSON.stringify(catalog, null, 2)}\n`;
  if (options.check) {
    let observed = "";
    try {
      // Both paths are explicit operator inputs to this local, read/write sync tool.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      observed = await readFile(options.outputPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (observed !== rendered) {
      throw new Error(
        "public catalog snapshot is stale; run `npm run sync:catalog` from typescript/",
      );
    }
    process.stdout.write(
      `public-catalog-sync=ok plans=${String(catalog.plans.length)}\n`,
    );
    return;
  }
  // The target is the explicit output selected by the operator.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await mkdir(dirname(options.outputPath), { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await writeFile(options.outputPath, rendered, "utf8");
  process.stdout.write(`wrote ${options.outputPath}\n`);
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(resolve(invokedPath)).href
) {
  syncPublicReferenceCatalog(parseArguments(process.argv.slice(2))).catch(
    (error: unknown) => {
      const detail = error instanceof Error ? error.message : "unknown error";
      process.stderr.write(`${detail}\n`);
      process.exitCode = 1;
    },
  );
}
