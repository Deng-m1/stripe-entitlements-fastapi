import { readFile } from "node:fs/promises";

import { parse } from "smol-toml";

import {
  CATALOG_PRICE_MAJOR_UNIT_MAX,
  JSON_SAFE_INTEGER_MAX,
  POSTGRES_BIGINT_MAX,
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
const ROOT_FIELDS = new Set(["plans", "credit_packs"]);
const PLAN_FIELDS = new Set([
  "name",
  "description",
  "currency",
  "rank",
  "monthly_credits",
  "month_usd",
  "year_usd",
  "features",
  "limits",
]);
const CREDIT_PACK_FIELDS = new Set([
  "name",
  "description",
  "currency",
  "rank",
  "credits",
  "price_usd",
  "expires_days",
]);

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
  if (features.length !== new Set(features).size) {
    throw new TypeError(`plans.${planKey}.features must contain no duplicates`);
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
  if (!isPlainRecord(value)) {
    throw new TypeError(`plans.${planKey}.limits must be a table`);
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

function rejectUnknownFields(
  table: Record<string, unknown>,
  owner: string,
  allowed: ReadonlySet<string>,
): void {
  const unknown = Object.keys(table)
    .filter((field) => !allowed.has(field))
    .sort();
  if (unknown.length > 0) {
    throw new TypeError(
      `${owner} contains unknown fields: ${unknown.join(", ")}`,
    );
  }
}

function isPlainObjectRecord(value: unknown): boolean {
  if (!isPlainRecord(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function planFromTable(key: string, table: Record<string, unknown>): Plan {
  const owner = `plans.${key}`;
  rejectUnknownFields(table, owner, PLAN_FIELDS);
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
    features: parseFeatures(table["features"] ?? [], key),
    limits: parseLimits(table["limits"] ?? {}, key),
  });
}

function creditPackFromTable(
  key: string,
  table: Record<string, unknown>,
): CreditPack {
  const owner = `credit_packs.${key}`;
  rejectUnknownFields(table, owner, CREDIT_PACK_FIELDS);
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
    const canonicalPlans = new Map<string, Plan>();
    const featureKeys = new Set<string>();
    const limitKeys = new Set<string>();
    for (const [key, plan] of plans) {
      if (typeof plan !== "object" || plan === null) {
        throw new TypeError(
          "plans must map lowercase slug keys to Plan values",
        );
      }
      if (key === "free") {
        throw new TypeError(
          "'free' is reserved for the non-paid account state",
        );
      }
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
      if (
        !CreditAmount.isCreditAmount(plan.monthlyCredits) ||
        typeof plan.monthlyCredits.atoms !== "bigint"
      ) {
        throw new TypeError(
          `plans.${key}.monthly_credits must be a real CreditAmount`,
        );
      }
      const monthlyCreditAtoms = plan.monthlyCredits.atoms;
      if (monthlyCreditAtoms <= 0n) {
        throw new TypeError(
          `plans.${key}.monthly_credits must be a positive exact credit amount`,
        );
      }
      if (monthlyCreditAtoms > POSTGRES_BIGINT_MAX) {
        throw new RangeError(
          `plans.${key}.monthly_credits exceeds the PostgreSQL bigint atom range`,
        );
      }
      if (
        !Number.isSafeInteger(plan.monthUsd) ||
        !Number.isSafeInteger(plan.yearUsd) ||
        plan.monthUsd <= 0 ||
        plan.yearUsd <= 0 ||
        plan.monthUsd > CATALOG_PRICE_MAJOR_UNIT_MAX ||
        plan.yearUsd > CATALOG_PRICE_MAJOR_UNIT_MAX
      ) {
        throw new RangeError(
          "catalog prices in minor units must remain JSON-safe integers",
        );
      }
      if (!(plan.features instanceof Set)) {
        throw new TypeError("plan features must be a Set of valid string keys");
      }
      const features = new Set<string>(plan.features);
      if (
        [...features].some(
          (feature) =>
            typeof feature !== "string" || !ENTITLEMENT_KEY.test(feature),
        )
      ) {
        throw new TypeError(
          "plan features must contain only valid string keys",
        );
      }
      if (!isPlainObjectRecord(plan.limits)) {
        throw new TypeError(
          "plan limits must be a plain record of keys to integer values",
        );
      }
      const limits = Object.assign(
        Object.create(null) as Record<string, number>,
        plan.limits,
      );
      if (
        Object.entries(limits).some(
          ([name, value]) =>
            typeof name !== "string" ||
            !ENTITLEMENT_KEY.test(name) ||
            !Number.isSafeInteger(value) ||
            value < 0,
        )
      ) {
        throw new TypeError(
          "plan limits must contain only valid non-negative JSON-safe limits",
        );
      }
      if (features.has("monthly_credits") || "monthly_credits" in limits) {
        throw new TypeError(
          "monthly_credits is reserved and cannot be declared as a feature or limit",
        );
      }
      for (const feature of features) {
        featureKeys.add(feature);
      }
      for (const limit of Object.keys(limits)) {
        limitKeys.add(limit);
      }
      canonicalPlans.set(
        key,
        Object.freeze({
          key,
          name: plan.name,
          description: plan.description,
          currency: "usd",
          rank: plan.rank,
          monthlyCredits: Object.freeze(
            CreditAmount.fromAtoms(monthlyCreditAtoms),
          ),
          monthUsd: plan.monthUsd,
          yearUsd: plan.yearUsd,
          features: Object.freeze(features),
          limits: Object.freeze(limits),
        }),
      );
    }
    const ranks = [...canonicalPlans.values()].map((plan) => plan.rank);
    if (
      ranks.some((rank) => !Number.isSafeInteger(rank) || rank <= 0) ||
      new Set(ranks).size !== ranks.length
    ) {
      throw new TypeError(
        "plan ranks must be unique positive JSON-safe integers",
      );
    }
    const overlappingEntitlements = [...featureKeys]
      .filter((key) => limitKeys.has(key))
      .sort();
    if (overlappingEntitlements.length > 0) {
      throw new TypeError(
        `feature and limit entitlement keys must be globally disjoint: ${overlappingEntitlements.join(", ")}`,
      );
    }
    const canonicalPacks = new Map<string, CreditPack>();
    for (const [key, pack] of creditPacks) {
      if (typeof pack !== "object" || pack === null) {
        throw new TypeError(
          "creditPacks must map lowercase slug keys to CreditPack values",
        );
      }
      if (key !== pack.key || !KEY.test(key)) {
        throw new TypeError(
          "credit-pack keys must match their mapping key and use lowercase slugs",
        );
      }
      requiredVisibleString(pack.name, `credit_packs.${key}.name`, 120);
      requiredVisibleString(
        pack.description,
        `credit_packs.${key}.description`,
        500,
      );
      if (
        !CreditAmount.isCreditAmount(pack.credits) ||
        typeof pack.credits.atoms !== "bigint"
      ) {
        throw new TypeError(
          `credit_packs.${key}.credits must be a real CreditAmount`,
        );
      }
      const creditAtoms = pack.credits.atoms;
      if (
        pack.currency !== "usd" ||
        creditAtoms <= 0n ||
        creditAtoms > POSTGRES_BIGINT_MAX ||
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
      canonicalPacks.set(
        key,
        Object.freeze({
          key,
          name: pack.name,
          description: pack.description,
          currency: "usd",
          rank: pack.rank,
          credits: Object.freeze(CreditAmount.fromAtoms(creditAtoms)),
          priceUsd: pack.priceUsd,
          expiresDays: pack.expiresDays,
        }),
      );
    }
    const packRanks = [...canonicalPacks.values()].map((pack) => pack.rank);
    if (
      packRanks.some((rank) => !Number.isSafeInteger(rank) || rank <= 0) ||
      new Set(packRanks).size !== packRanks.length
    ) {
      throw new TypeError(
        "credit-pack ranks must be unique positive JSON-safe integers",
      );
    }
    const lookupOwners = new Map<string, string>();
    for (const key of canonicalPlans.keys()) {
      for (const interval of ["month", "year"] as const) {
        lookupOwners.set(
          `${lookupPrefix}_${key}_${interval}`,
          `plan '${key}' (${interval})`,
        );
      }
    }
    for (const key of canonicalPacks.keys()) {
      const lookupKey = `${lookupPrefix}_pack_${key}`;
      const previous = lookupOwners.get(lookupKey);
      if (previous !== undefined) {
        throw new TypeError(
          `generated Stripe lookup key '${lookupKey}' collides between ${previous} and credit pack '${key}'`,
        );
      }
      lookupOwners.set(lookupKey, `credit pack '${key}'`);
    }
    this.plans = canonicalPlans;
    this.creditPacks = canonicalPacks;
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
    if (!isPlainRecord(raw)) {
      throw new TypeError("plan catalog requires a non-empty [plans] table");
    }
    rejectUnknownFields(raw, "plan catalog", ROOT_FIELDS);
    if (
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
