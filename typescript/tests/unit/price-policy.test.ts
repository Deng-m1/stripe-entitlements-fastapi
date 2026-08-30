import { describe, expect, it } from "vitest";

import {
  catalogOneTimePriceMatches,
  catalogPriceMatches,
  type CatalogOneTimePriceExpectation,
  type CatalogPriceExpectation,
} from "../../src/price-policy.js";

const RECURRING_EXPECTED: CatalogPriceExpectation = {
  expectedCurrency: "usd",
  expectedUnitAmount: 1900,
  expectedInterval: "month",
  expectedProductLine: "example-entitlements",
  expectedPlanKey: "starter",
  expectedLookupKey: "ent_starter_month",
  expectedPriceId: "price_starter_month",
};

const PACK_EXPECTED: CatalogOneTimePriceExpectation = {
  expectedCurrency: "usd",
  expectedUnitAmount: 1500,
  expectedProductLine: "example-entitlements",
  expectedPackKey: "boost-100",
  expectedLookupKey: "ent_pack_boost-100",
};

function recurringPrice(): Record<string, unknown> {
  return {
    id: "price_starter_month",
    lookup_key: "ent_starter_month",
    active: true,
    type: "recurring",
    currency: "usd",
    unit_amount: 1900,
    billing_scheme: "per_unit",
    recurring: {
      interval: "month",
      interval_count: 1,
      usage_type: "licensed",
    },
    tax_behavior: "unspecified",
    tiers_mode: null,
    transform_quantity: null,
    custom_unit_amount: null,
    currency_options: null,
    product: {
      id: "prod_starter",
      active: true,
      metadata: {
        product_line: "example-entitlements",
        plan: "starter",
      },
    },
  };
}

function packPrice(): Record<string, unknown> {
  return {
    id: "price_pack_boost_100",
    lookup_key: "ent_pack_boost-100",
    active: true,
    type: "one_time",
    currency: "usd",
    unit_amount: 1500,
    billing_scheme: "per_unit",
    recurring: null,
    tax_behavior: "unspecified",
    tiers_mode: null,
    transform_quantity: null,
    custom_unit_amount: null,
    currency_options: null,
    metadata: {
      product_line: "example-entitlements",
      credit_pack: "boost-100",
    },
    product: {
      id: "prod_pack_boost_100",
      active: true,
      metadata: {
        product_line: "example-entitlements",
        credit_pack: "boost-100",
      },
    },
  };
}

function nestedRecord(
  owner: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = owner[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${key} is not a test record`);
  }
  return value as Record<string, unknown>;
}

describe("recurring catalog Price policy", () => {
  it("accepts the exact supported shape and never mutates it", () => {
    const price = recurringPrice();
    const before = structuredClone(price);
    expect(catalogPriceMatches(price, RECURRING_EXPECTED)).toBe(true);
    expect(price).toEqual(before);
  });

  it("accepts missing defaults, split metadata, and the one default currency option", () => {
    const price = recurringPrice();
    delete price["type"];
    delete price["billing_scheme"];
    const recurring = nestedRecord(price, "recurring");
    delete recurring["interval_count"];
    delete recurring["usage_type"];
    const product = nestedRecord(price, "product");
    product["metadata"] = { product_line: "example-entitlements" };
    price["metadata"] = { plan: "starter" };
    price["currency_options"] = {
      usd: {
        custom_unit_amount: null,
        tax_behavior: "unspecified",
        unit_amount: 1900,
        unit_amount_decimal: "1900",
      },
    };
    expect(catalogPriceMatches(price, RECURRING_EXPECTED)).toBe(true);
  });

  it.each([
    ["unit_amount", "1900"],
    ["unit_amount", true],
    ["unit_amount", 1900.5],
    ["unit_amount", Number.MAX_SAFE_INTEGER + 1],
    ["currency", 123],
    ["currency", "USD"],
    ["active", "true"],
    ["lookup_key", "ent_pro_month"],
    ["id", "price_other"],
    ["type", "one_time"],
    ["billing_scheme", "tiered"],
    ["tiers_mode", "graduated"],
    ["transform_quantity", { divide_by: 10 }],
    ["custom_unit_amount", { enabled: true }],
    ["tax_behavior", "exclusive"],
  ] as const)("rejects top-level drift in %s", (field, value) => {
    const price = recurringPrice();
    price[field] = value;
    expect(catalogPriceMatches(price, RECURRING_EXPECTED)).toBe(false);
  });

  it.each([
    ["interval", "year"],
    ["interval_count", "1"],
    ["interval_count", true],
    ["interval_count", 1.5],
    ["interval_count", 2],
    ["usage_type", "metered"],
  ] as const)("rejects recurring drift in %s", (field, value) => {
    const price = recurringPrice();
    nestedRecord(price, "recurring")[field] = value;
    expect(catalogPriceMatches(price, RECURRING_EXPECTED)).toBe(false);
  });

  it.each([
    { eur: { unit_amount: 1900 } },
    { usd: { unit_amount: 1900 }, eur: { unit_amount: 1900 } },
    { usd: { unit_amount: "1900" } },
    { usd: { unit_amount: 1900.5 } },
    { usd: { unit_amount: Number.MAX_SAFE_INTEGER + 1 } },
    { usd: { unit_amount: 1800 } },
    { usd: { unit_amount: 1900, custom_unit_amount: { enabled: true } } },
    { usd: { unit_amount: 1900, tax_behavior: "exclusive" } },
    { usd: [] },
    [],
  ])("rejects unsupported currency options %#", (currencyOptions) => {
    const price = recurringPrice();
    price["currency_options"] = currencyOptions;
    expect(catalogPriceMatches(price, RECURRING_EXPECTED)).toBe(false);
  });

  it("allows archived historical Prices only when explicitly requested", () => {
    const price = recurringPrice();
    price["active"] = false;
    nestedRecord(price, "product")["active"] = false;
    expect(catalogPriceMatches(price, RECURRING_EXPECTED)).toBe(false);
    expect(
      catalogPriceMatches(price, {
        ...RECURRING_EXPECTED,
        requireActive: false,
      }),
    ).toBe(true);
  });

  it.each(["product_line", "plan"])(
    "rejects metadata identity drift in %s",
    (field) => {
      const price = recurringPrice();
      const metadata = nestedRecord(nestedRecord(price, "product"), "metadata");
      metadata[field] = "other";
      expect(catalogPriceMatches(price, RECURRING_EXPECTED)).toBe(false);

      const priceMetadata = recurringPrice();
      priceMetadata["metadata"] = {
        product_line: "example-entitlements",
        plan: "starter",
        [field]: "other",
      };
      expect(catalogPriceMatches(priceMetadata, RECURRING_EXPECTED)).toBe(
        false,
      );
    },
  );

  it("rejects non-expanded, array, prototype-bearing, and accessor-bearing objects", () => {
    const price = recurringPrice();
    price["product"] = "prod_starter";
    expect(catalogPriceMatches(price, RECURRING_EXPECTED)).toBe(false);

    const arrayMetadata = recurringPrice();
    nestedRecord(arrayMetadata, "product")["metadata"] = [];
    expect(catalogPriceMatches(arrayMetadata, RECURRING_EXPECTED)).toBe(false);

    class Product {
      public readonly active = true;
    }
    const classProduct = recurringPrice();
    classProduct["product"] = new Product();
    expect(catalogPriceMatches(classProduct, RECURRING_EXPECTED)).toBe(false);

    let accessed = false;
    const accessorPrice = Object.defineProperty({}, "product", {
      enumerable: true,
      get: () => {
        accessed = true;
        return {};
      },
    });
    expect(catalogPriceMatches(accessorPrice, RECURRING_EXPECTED)).toBe(false);
    expect(accessed).toBe(false);
  });
});

describe("one-time credit-pack Price policy", () => {
  it("accepts the exact supported shape without mutation", () => {
    const price = packPrice();
    const before = structuredClone(price);
    expect(catalogOneTimePriceMatches(price, PACK_EXPECTED)).toBe(true);
    expect(price).toEqual(before);
  });

  it("allows archived pack Prices only for historical validation", () => {
    const price = packPrice();
    price["active"] = false;
    nestedRecord(price, "product")["active"] = false;
    expect(catalogOneTimePriceMatches(price, PACK_EXPECTED)).toBe(false);
    expect(
      catalogOneTimePriceMatches(price, {
        ...PACK_EXPECTED,
        requireActive: false,
      }),
    ).toBe(true);
  });

  it.each([
    ["lookup_key", "ent_pack_other"],
    ["type", "recurring"],
    ["recurring", { interval: "month" }],
    ["currency", "EUR"],
    ["unit_amount", "1500"],
    ["unit_amount", true],
    ["unit_amount", 1500.5],
    ["billing_scheme", "tiered"],
    ["tiers_mode", "volume"],
    ["transform_quantity", { divide_by: 10 }],
    ["custom_unit_amount", { enabled: true }],
    ["tax_behavior", "inclusive"],
  ] as const)("rejects pack Price drift in %s", (field, value) => {
    const price = packPrice();
    price[field] = value;
    expect(catalogOneTimePriceMatches(price, PACK_EXPECTED)).toBe(false);
  });

  it.each([
    ["product_line", "other"],
    ["credit_pack", "other-pack"],
    ["plan", "starter"],
  ] as const)("rejects forbidden pack metadata %s", (field, value) => {
    for (const owner of ["price", "product"] as const) {
      const price = packPrice();
      const metadata =
        owner === "price"
          ? nestedRecord(price, "metadata")
          : nestedRecord(nestedRecord(price, "product"), "metadata");
      metadata[field] = value;
      expect(catalogOneTimePriceMatches(price, PACK_EXPECTED)).toBe(false);
    }
  });

  it("rejects malformed currency options and missing active identity", () => {
    const malformed = packPrice();
    malformed["currency_options"] = { usd: { unit_amount: 1500 }, eur: {} };
    expect(catalogOneTimePriceMatches(malformed, PACK_EXPECTED)).toBe(false);

    const missingActive = packPrice();
    delete missingActive["active"];
    expect(catalogOneTimePriceMatches(missingActive, PACK_EXPECTED)).toBe(
      false,
    );
  });
});
