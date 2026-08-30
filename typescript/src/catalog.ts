import { readFile } from "node:fs/promises";

import { parse } from "smol-toml";

import {
  CATALOG_PRICE_MAJOR_UNIT_MAX,
  JSON_SAFE_INTEGER_MAX,
} from "./bounds.js";
import { CreditAmount } from "./credit-amount.js";
import type { BillingInterval } from "./types.js";
import {
  isPlainRecord,
  requiredSafeInteger,
  requiredVisibleString,
} from "./validation.js";

const KEY = /^[a-z][a-z0-9-]{0,31}$/u;
const ENTITLEMENT_KEY = /^[a-z][a-z0-9_]{0,63}$/u;

export interface Plan {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly currency: "usd";
  readonly rank: number;
  readonly monthlyCredits: CreditAmount;
  readonly monthUsd: number;
  readonly yearUsd: number;
  readonly features: ReadonlySet<string>;
  readonly limits: Readonly<Record<string, number>>;
}

export interface CreditPack {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly currency: "usd";
  readonly rank: number;
  readonly credits: CreditAmount;
  readonly priceUsd: number;
  readonly expiresDays: number;
}

function parseFeatures(value: unknown, planKey: string): ReadonlySet<string> {
  if (!Array.isArray(value)) {
    throw new TypeError(`plans.${planKey}.features must be an array`);
  }
  const features = value.map((item) =>
    requiredVisibleString(item, `plans.${planKey}.features[]`, 64),
  );
  if (features.length === 0 || features.length !== new Set(features).size) {
    throw new TypeError(
      `plans.${planKey}.features must be non-empty and contain no duplicates`,
    );
  }
  if (features.some((feature) => !ENTITLEMENT_KEY.test(feature))) {
    throw new TypeError(`plans.${planKey}.features contains an invalid key`);
  }
  return new Set(features);
}

function parseLimits(
  value: unknown,
  planKey: string,
): Readonly<Record<string, number>> {
  if (!isPlainRecord(value) || Object.keys(value).length === 0) {
    throw new TypeError(`plans.${planKey}.limits must be a non-empty table`);
  }
  const limits: Record<string, number> = Object.create(null) as Record<
    string,
    number
  >;
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = requiredVisibleString(
      rawKey,
      `plans.${planKey}.limits key`,
      64,
    );
    if (!ENTITLEMENT_KEY.test(key)) {
      throw new TypeError(`plans.${planKey}.limits contains an invalid key`);
    }
    limits[key] = requiredSafeInteger(
      rawValue,
      `plans.${planKey}.limits.${key}`,
      0,
      JSON_SAFE_INTEGER_MAX,
    );
  }
  return Object.freeze(limits);
}

function requiredField(
  table: Record<string, unknown>,
  field: string,
  owner: string,
): unknown {
  if (!(field in table)) {
    throw new TypeError(`${owner} is missing required field '${field}'`);
  }
  return table[field];
}

function planFromTable(key: string, table: Record<string, unknown>): Plan {
  const owner = `plans.${key}`;
  const currency = requiredVisibleString(
    requiredField(table, "currency", owner),
    `${owner}.currency`,
    3,
  );
  if (currency !== "usd") {
    throw new TypeError("the reference catalog supports USD only");
  }
  return Object.freeze({
    key,
    name: requiredVisibleString(
      requiredField(table, "name", owner),
      `${owner}.name`,
      120,
    ),
    description: requiredVisibleString(
      requiredField(table, "description", owner),
      `${owner}.description`,
      500,
    ),
    currency,
    rank: requiredSafeInteger(
      requiredField(table, "rank", owner),
      `${owner}.rank`,
    ),
    monthlyCredits: CreditAmount.parse(
      requiredField(table, "monthly_credits", owner),
      {
        field: `${owner}.monthly_credits`,
        allowZero: false,
      },
    ),
    monthUsd: requiredSafeInteger(
      requiredField(table, "month_usd", owner),
      `${owner}.month_usd`,
    ),
    yearUsd: requiredSafeInteger(
      requiredField(table, "year_usd", owner),
      `${owner}.year_usd`,
    ),
    features: parseFeatures(requiredField(table, "features", owner), key),
    limits: parseLimits(requiredField(table, "limits", owner), key),
  });
}

function creditPackFromTable(
  key: string,
  table: Record<string, unknown>,
): CreditPack {
  const owner = `credit_packs.${key}`;
  const currency = requiredVisibleString(
    requiredField(table, "currency", owner),
    `${owner}.currency`,
    3,
  );
  if (currency !== "usd") {
    throw new TypeError("the reference credit-pack catalog supports USD only");
  }
  return Object.freeze({
    key,
    name: requiredVisibleString(
      requiredField(table, "name", owner),
      `${owner}.name`,
      120,
    ),
    description: requiredVisibleString(
      requiredField(table, "description", owner),
      `${owner}.description`,
      500,
    ),
    currency,
    rank: requiredSafeInteger(
      requiredField(table, "rank", owner),
      `${owner}.rank`,
    ),
    credits: CreditAmount.parse(requiredField(table, "credits", owner), {
      field: `${owner}.credits`,
      allowZero: false,
    }),
    priceUsd: requiredSafeInteger(
      requiredField(table, "price_usd", owner),
      `${owner}.price_usd`,
    ),
    expiresDays: requiredSafeInteger(
      requiredField(table, "expires_days", owner),
      `${owner}.expires_days`,
      1,
      3650,
    ),
  });
}

export class PlanCatalog {
  public readonly plans: ReadonlyMap<string, Plan>;
  public readonly creditPacks: ReadonlyMap<string, CreditPack>;
  public readonly lookupPrefix: string;

  public constructor(
    plans: ReadonlyMap<string, Plan>,
    lookupPrefix = "ent",
    creditPacks: ReadonlyMap<string, CreditPack> = new Map(),
  ) {
    if (plans.size === 0) {
      throw new TypeError("at least one plan is required");
    }
    if (!KEY.test(lookupPrefix)) {
      throw new TypeError("lookup_prefix must match [a-z][a-z0-9-]{0,31}");
    }
    const ranks = [...plans.values()].map((plan) => plan.rank);
    if (
      ranks.some((rank) => !Number.isSafeInteger(rank) || rank <= 0) ||
      new Set(ranks).size !== ranks.length
    ) {
      throw new TypeError(
        "plan ranks must be unique positive JSON-safe integers",
      );
    }
    for (const [key, plan] of plans) {
      if (key !== plan.key || !KEY.test(key)) {
        throw new TypeError(
          "plan keys must match their mapping key and use lowercase slugs",
        );
      }
      requiredVisibleString(plan.name, `plans.${key}.name`, 120);
      requiredVisibleString(plan.description, `plans.${key}.description`, 500);
      if (plan.currency !== "usd") {
        throw new TypeError("the reference catalog supports USD only");
      }
      if (plan.monthlyCredits.atoms <= 0n) {
        throw new TypeError(
          `plans.${key}.monthly_credits must be a positive exact credit amount`,
        );
      }
      if (
        plan.monthUsd <= 0 ||
        plan.yearUsd <= 0 ||
        plan.monthUsd > CATALOG_PRICE_MAJOR_UNIT_MAX ||
        plan.yearUsd > CATALOG_PRICE_MAJOR_UNIT_MAX
      ) {
        throw new RangeError(
          "catalog prices in minor units must remain JSON-safe integers",
        );
      }
      if (plan.yearUsd > plan.monthUsd * 12) {
        throw new RangeError(
          `plans.${key}.year_usd cannot exceed twelve monthly payments`,
        );
      }
      if (
        plan.features.size === 0 ||
        [...plan.features].some((feature) => !ENTITLEMENT_KEY.test(feature))
      ) {
        throw new TypeError(
          "every plan requires explicit valid non-empty features",
        );
      }
      if (
        Object.keys(plan.limits).length === 0 ||
        Object.entries(plan.limits).some(
          ([name, value]) =>
            !ENTITLEMENT_KEY.test(name) ||
            !Number.isSafeInteger(value) ||
            value < 0,
        )
      ) {
        throw new TypeError(
          "every plan requires explicit valid non-negative JSON-safe limits",
        );
      }
    }
    const ordered = [...plans.values()].sort(
      (left, right) => left.rank - right.rank,
    );
    const first = ordered[0];
    if (first === undefined) {
      throw new TypeError("at least one plan is required");
    }
    const expectedLimitKeys = new Set(Object.keys(first.limits));
    let previous = first;
    for (const plan of ordered.slice(1)) {
      const keys = Object.keys(plan.limits);
      if (
        keys.length !== expectedLimitKeys.size ||
        keys.some((key) => !expectedLimitKeys.has(key))
      ) {
        throw new TypeError(
          "all plans must define the same explicit limit keys",
        );
      }
      if (plan.monthlyCredits.atoms <= previous.monthlyCredits.atoms) {
        throw new TypeError(
          "monthly credits must increase strictly with plan rank",
        );
      }
      if (
        [...previous.features].some((feature) => !plan.features.has(feature))
      ) {
        throw new TypeError(
          "higher-ranked plans cannot remove lower-tier features",
        );
      }
      if (
        keys.some(
          (key) => (plan.limits[key] ?? -1) < (previous.limits[key] ?? 0),
        )
      ) {
        throw new TypeError(
          "higher-ranked plans cannot reduce lower-tier limits",
        );
      }
      previous = plan;
    }
    const packRanks = [...creditPacks.values()].map((pack) => pack.rank);
    if (new Set(packRanks).size !== packRanks.length) {
      throw new TypeError("credit-pack ranks must be unique");
    }
    for (const [key, pack] of creditPacks) {
      if (key !== pack.key || !KEY.test(key)) {
        throw new TypeError(
          "credit-pack keys must match their mapping key and use lowercase slugs",
        );
      }
      if (
        pack.currency !== "usd" ||
        pack.credits.atoms <= 0n ||
        !Number.isSafeInteger(pack.priceUsd) ||
        pack.priceUsd <= 0 ||
        pack.priceUsd > CATALOG_PRICE_MAJOR_UNIT_MAX ||
        !Number.isSafeInteger(pack.expiresDays) ||
        pack.expiresDays < 1 ||
        pack.expiresDays > 3650
      ) {
        throw new TypeError(
          `credit_packs.${key} has an invalid immutable catalog value`,
        );
      }
    }
    this.plans = new Map(plans);
    this.creditPacks = new Map(creditPacks);
    this.lookupPrefix = lookupPrefix;
  }

  public static async fromToml(
    path: string,
    lookupPrefix = "ent",
  ): Promise<PlanCatalog> {
    let raw: unknown;
    try {
      const text = await readFile(path, "utf8");
      raw = parse(text, { integersAsBigInt: "asNeeded" });
    } catch (error: unknown) {
      const name = error instanceof Error ? error.name : "UnknownError";
      throw new TypeError(`cannot load plan catalog: ${name}`);
    }
    if (
      !isPlainRecord(raw) ||
      !isPlainRecord(raw["plans"]) ||
      Object.keys(raw["plans"]).length === 0
    ) {
      throw new TypeError("plan catalog requires a non-empty [plans] table");
    }
    const plans = new Map<string, Plan>();
    for (const [rawKey, value] of Object.entries(raw["plans"])) {
      const key = requiredVisibleString(rawKey, "plan key", 32);
      if (!isPlainRecord(value)) {
        throw new TypeError(`plans.${key} must be a table`);
      }
      plans.set(key, planFromTable(key, value));
    }
    const packsValue = raw["credit_packs"] ?? {};
    if (!isPlainRecord(packsValue)) {
      throw new TypeError("credit_packs must be a table");
    }
    const packs = new Map<string, CreditPack>();
    for (const [rawKey, value] of Object.entries(packsValue)) {
      const key = requiredVisibleString(rawKey, "credit-pack key", 32);
      if (!isPlainRecord(value)) {
        throw new TypeError(`credit_packs.${key} must be a table`);
      }
      packs.set(key, creditPackFromTable(key, value));
    }
    return new PlanCatalog(plans, lookupPrefix, packs);
  }

  public ordered(): readonly Plan[] {
    return [...this.plans.values()].sort(
      (left, right) => left.rank - right.rank,
    );
  }

  public require(key: string): Plan {
    const plan = this.plans.get(key);
    if (plan === undefined) {
      throw new TypeError(`unknown plan '${key}'`);
    }
    return plan;
  }

  public orderedCreditPacks(): readonly CreditPack[] {
    return [...this.creditPacks.values()].sort(
      (left, right) => left.rank - right.rank,
    );
  }

  public requireCreditPack(key: string): CreditPack {
    const pack = this.creditPacks.get(key);
    if (pack === undefined) {
      throw new TypeError(`unknown credit pack '${key}'`);
    }
    return pack;
  }

  public creditPackLookupKey(key: string): string {
    this.requireCreditPack(key);
    return `${this.lookupPrefix}_pack_${key}`;
  }

  public lookupKey(plan: string, interval: BillingInterval): string {
    this.require(plan);
    return `${this.lookupPrefix}_${plan}_${interval}`;
  }

  public parseLookupKey(
    lookupKey: string | undefined,
  ): readonly [Plan, BillingInterval] | undefined {
    if (lookupKey === undefined || lookupKey.length === 0) {
      return undefined;
    }
    const parts = lookupKey.split("_");
    if (parts.length !== 3 || parts[0] !== this.lookupPrefix) {
      return undefined;
    }
    const planKey = parts[1];
    const interval = parts[2];
    if (
      planKey === undefined ||
      (interval !== "month" && interval !== "year")
    ) {
      return undefined;
    }
    const plan = this.plans.get(planKey);
    return plan === undefined ? undefined : [plan, interval];
  }
}
