import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { PlanCatalog } from "../../src/catalog.js";

const ROOT_CATALOG = fileURLToPath(
  new URL("../../../plans.toml", import.meta.url),
);

describe("shared plan catalog", () => {
  it("loads all plans and credit packs without numeric drift", async () => {
    const catalog = await PlanCatalog.fromToml(ROOT_CATALOG, "pptx");
    expect(catalog.ordered().map((plan) => plan.key)).toEqual([
      "starter",
      "pro",
      "ultra",
    ]);
    expect(catalog.orderedCreditPacks().map((pack) => pack.key)).toEqual([
      "boost-100",
      "boost-500",
      "boost-2000",
    ]);
    expect(catalog.require("starter").monthlyCredits.atoms).toBe(300_000_000n);
    expect(catalog.requireCreditPack("boost-2000").credits.atoms).toBe(
      2_000_000_000n,
    );
    expect(catalog.lookupKey("pro", "year")).toBe("pptx_pro_year");
    expect(catalog.creditPackLookupKey("boost-100")).toBe(
      "pptx_pack_boost-100",
    );
    expect(catalog.parseLookupKey("pptx_ultra_month")?.[0].key).toBe("ultra");
    expect(catalog.parseLookupKey("other_ultra_month")).toBeUndefined();
  });

  it("uses explicit tier ranks rather than prices", async () => {
    const catalog = await PlanCatalog.fromToml(ROOT_CATALOG);
    expect(catalog.require("starter").rank).toBeLessThan(
      catalog.require("pro").rank,
    );
    expect(catalog.require("pro").rank).toBeLessThan(
      catalog.require("ultra").rank,
    );
  });
});
