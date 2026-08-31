import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { POSTGRES_BIGINT_MAX } from "../../src/bounds.js";
import { PlanCatalog } from "../../src/catalog.js";
import { CreditAmount } from "../../src/credit-amount.js";

const ROOT_CATALOG = fileURLToPath(
  new URL("../../../plans.toml", import.meta.url),
);
const CREDITS_ONLY_CATALOG = fileURLToPath(
  new URL("../fixtures/catalog-credits-only.toml", import.meta.url),
);
const UNKNOWN_ROOT_CATALOG = fileURLToPath(
  new URL("../fixtures/catalog-unknown-root.toml", import.meta.url),
);
const UNKNOWN_PLAN_FIELD_CATALOG = fileURLToPath(
  new URL("../fixtures/catalog-unknown-plan-field.toml", import.meta.url),
);
const UNKNOWN_PACK_FIELD_CATALOG = fileURLToPath(
  new URL("../fixtures/catalog-unknown-pack-field.toml", import.meta.url),
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

  it("accepts an annual price above twelve monthly payments", async () => {
    const source = await PlanCatalog.fromToml(ROOT_CATALOG);
    const starter = source.require("starter");
    const annualPrice = starter.monthUsd * 12 + 1;
    const catalog = new PlanCatalog(
      new Map([
        [
          starter.key,
          Object.freeze({
            ...starter,
            yearUsd: annualPrice,
          }),
        ],
      ]),
    );

    expect(catalog.require("starter").yearUsd).toBe(annualPrice);
  });

  it("accepts product-defined tradeoffs between ranked plans", async () => {
    const source = await PlanCatalog.fromToml(ROOT_CATALOG);
    const starter = source.require("starter");
    const pro = source.require("pro");
    const tradeoff = Object.freeze({
      ...pro,
      monthlyCredits: starter.monthlyCredits,
      features: new Set(["api_access"]),
      limits: Object.freeze({ team_members: 5 }),
    });

    const catalog = new PlanCatalog(
      new Map([
        [starter.key, starter],
        [tradeoff.key, tradeoff],
      ]),
    );

    expect(catalog.require("pro")).toEqual(tradeoff);
  });

  it("defaults omitted feature and limit collections to empty", async () => {
    const catalog = await PlanCatalog.fromToml(CREDITS_ONLY_CATALOG);
    expect([...catalog.require("credits-only").features]).toEqual([]);
    expect(catalog.require("credits-only").limits).toEqual({});
  });

  it("validates direct constructor numbers and credit-pack metadata", async () => {
    const source = await PlanCatalog.fromToml(ROOT_CATALOG);
    const starter = source.require("starter");
    expect(
      () =>
        new PlanCatalog(
          new Map([[starter.key, { ...starter, monthUsd: 1.5 }]]),
        ),
    ).toThrow("JSON-safe integers");

    const pack = source.requireCreditPack("boost-100");
    expect(
      () =>
        new PlanCatalog(
          new Map([[starter.key, starter]]),
          "ent",
          new Map([[pack.key, { ...pack, rank: 0 }]]),
        ),
    ).toThrow("credit-pack ranks");
  });

  it("rejects direct plan and pack credits outside PostgreSQL bigint", async () => {
    const source = await PlanCatalog.fromToml(ROOT_CATALOG);
    const starter = source.require("starter");
    expect(
      () =>
        new PlanCatalog(
          new Map([
            [
              starter.key,
              {
                ...starter,
                monthlyCredits: CreditAmount.fromAtoms(
                  POSTGRES_BIGINT_MAX + 1n,
                ),
              },
            ],
          ]),
        ),
    ).toThrow("PostgreSQL bigint atom range");

    const pack = source.requireCreditPack("boost-100");
    expect(
      () =>
        new PlanCatalog(
          new Map([[starter.key, starter]]),
          "ent",
          new Map([
            [
              pack.key,
              {
                ...pack,
                credits: CreditAmount.fromAtoms(POSTGRES_BIGINT_MAX + 1n),
              },
            ],
          ]),
        ),
    ).toThrow("invalid immutable catalog value");
  });

  it("reserves free for the non-paid account state", async () => {
    const source = await PlanCatalog.fromToml(ROOT_CATALOG);
    const starter = source.require("starter");

    expect(
      () => new PlanCatalog(new Map([["free", { ...starter, key: "free" }]])),
    ).toThrow("reserved");
  });

  it("rejects collisions across recurring and credit-pack lookup keys", async () => {
    const source = await PlanCatalog.fromToml(ROOT_CATALOG);
    const plan = { ...source.require("starter"), key: "pack" };
    const pack = { ...source.requireCreditPack("boost-100"), key: "month" };

    expect(
      () =>
        new PlanCatalog(
          new Map([[plan.key, plan]]),
          "ent",
          new Map([[pack.key, pack]]),
        ),
    ).toThrow(/lookup key.*collides/u);
  });

  it.each(["features", "limits"] as const)(
    "reserves synthesized monthly_credits from %s",
    async (namespace) => {
      const source = await PlanCatalog.fromToml(ROOT_CATALOG);
      const starter = source.require("starter");
      const plan =
        namespace === "features"
          ? { ...starter, features: new Set(["monthly_credits"]) }
          : { ...starter, limits: { monthly_credits: 1 } };

      expect(() => new PlanCatalog(new Map([[plan.key, plan]]))).toThrow(
        "monthly_credits is reserved",
      );
    },
  );

  it("keeps feature and limit entitlement namespaces globally disjoint", async () => {
    const source = await PlanCatalog.fromToml(ROOT_CATALOG);
    const starter = {
      ...source.require("starter"),
      features: new Set(["shared_key"]),
    };
    const pro = {
      ...source.require("pro"),
      features: new Set(source.require("pro").features),
      limits: { shared_key: 1 },
    };

    expect(
      () =>
        new PlanCatalog(
          new Map([
            [starter.key, starter],
            [pro.key, pro],
          ]),
        ),
    ).toThrow("globally disjoint: shared_key");
  });

  it("rejects invalid runtime feature and limit containers", async () => {
    const source = await PlanCatalog.fromToml(ROOT_CATALOG);
    const starter = source.require("starter");

    expect(
      () =>
        new PlanCatalog(
          new Map([
            [
              starter.key,
              {
                ...starter,
                features: ["api_access"] as unknown as ReadonlySet<string>,
              },
            ],
          ]),
        ),
    ).toThrow("features must be a Set");
    expect(
      () =>
        new PlanCatalog(
          new Map([
            [
              starter.key,
              {
                ...starter,
                features: new Set([7 as unknown as string]),
              },
            ],
          ]),
        ),
    ).toThrow("valid string keys");
    expect(
      () =>
        new PlanCatalog(
          new Map([
            [
              starter.key,
              {
                ...starter,
                limits: new Map() as unknown as Readonly<
                  Record<string, number>
                >,
              },
            ],
          ]),
        ),
    ).toThrow("limits must be a plain record");
  });

  it("rejects structurally fake CreditAmount objects", async () => {
    const source = await PlanCatalog.fromToml(ROOT_CATALOG);
    const starter = source.require("starter");
    const pack = source.requireCreditPack("boost-100");
    const fake = { atoms: 1_000_000n } as CreditAmount;
    const forgedPrototype = Object.assign(
      Object.create(CreditAmount.prototype) as CreditAmount,
      { atoms: 1_000_000n },
    );

    expect(
      () =>
        new PlanCatalog(
          new Map([[starter.key, { ...starter, monthlyCredits: fake }]]),
        ),
    ).toThrow("real CreditAmount");
    expect(
      () =>
        new PlanCatalog(
          new Map([[starter.key, starter]]),
          "ent",
          new Map([[pack.key, { ...pack, credits: fake }]]),
        ),
    ).toThrow("real CreditAmount");
    expect(
      () =>
        new PlanCatalog(
          new Map([
            [starter.key, { ...starter, monthlyCredits: forgedPrototype }],
          ]),
        ),
    ).toThrow("real CreditAmount");
  });

  it("defensively copies mutable TypeScript constructor inputs", async () => {
    const source = await PlanCatalog.fromToml(ROOT_CATALOG);
    const starter = source.require("starter");
    const sourceFeatures = new Set(["private_feature"]);
    const sourceLimits = { job_limit: 3 };
    const sourceCredits = CreditAmount.fromAtoms(5_000_000n);
    const sourcePlan = {
      ...starter,
      monthlyCredits: sourceCredits,
      features: sourceFeatures,
      limits: sourceLimits,
    };
    const sourcePlans = new Map([[sourcePlan.key, sourcePlan]]);

    const copied = new PlanCatalog(sourcePlans);
    sourceFeatures.add("later_feature");
    sourceLimits.job_limit = 99;
    Object.defineProperty(sourceCredits, "atoms", { value: 99_000_000n });
    sourcePlans.clear();

    expect([...copied.require("starter").features]).toEqual([
      "private_feature",
    ]);
    expect(copied.require("starter").limits).toEqual({ job_limit: 3 });
    expect(copied.require("starter").monthlyCredits.atoms).toBe(5_000_000n);
  });

  it.each([
    [UNKNOWN_ROOT_CATALOG, "plan catalog", "catalog_version"],
    [UNKNOWN_PLAN_FIELD_CATALOG, "plans.starter", "feature"],
    [UNKNOWN_PACK_FIELD_CATALOG, "credit_packs.boost", "expires_day"],
  ])(
    "rejects unknown fields in %s instead of ignoring typos",
    async (path, owner, field) => {
      await expect(PlanCatalog.fromToml(path)).rejects.toThrow(
        `${owner} contains unknown fields: ${field}`,
      );
    },
  );
});
