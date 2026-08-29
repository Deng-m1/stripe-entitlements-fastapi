import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, test } from "vitest";

import { PlanCatalog } from "../../src/catalog.js";
import { loadSettings, type Settings } from "../../src/config.js";
import { runDoctor, type DoctorStripeNetwork } from "../../src/doctor.js";
import { postgresDatabase } from "../support/postgres-setup.js";

const ROOT_CATALOG = fileURLToPath(
  new URL("../../../plans.toml", import.meta.url),
);
let catalog: PlanCatalog;

beforeAll(async () => {
  catalog = await PlanCatalog.fromToml(ROOT_CATALOG);
});

function settings(overrides: Readonly<Record<string, string>> = {}): Settings {
  return loadSettings({
    DATABASE_URL: "postgresql://doctor.invalid/doctor",
    STRIPE_SECRET_KEY: "sk_test_doctor_valid",
    STRIPE_WEBHOOK_SECRET: "whsec_doctor_valid",
    STRIPE_WEBHOOK_API_VERSION: "2026-06-24.dahlia",
    STRIPE_PORTAL_CONFIGURATION_ID: "bpc_doctor_valid",
    PLAN_CATALOG_PATH: ROOT_CATALOG,
    APP_ENV: "test",
    FRONTEND_ORIGINS: "https://app.example",
    CHECKOUT_SUCCESS_URL: "https://app.example/billing/success",
    CHECKOUT_CANCEL_URL: "https://app.example/pricing",
    PORTAL_RETURN_URL: "https://app.example/account",
    ...overrides,
  });
}

function recurringPrice(lookupKey: string): Record<string, unknown> {
  const parsed = catalog.parseLookupKey(lookupKey);
  if (parsed === undefined) throw new Error("unexpected recurring lookup");
  const [plan, interval] = parsed;
  return {
    id: `price_${plan.key}_${interval}`,
    active: true,
    lookup_key: lookupKey,
    currency: plan.currency,
    unit_amount: (interval === "month" ? plan.monthUsd : plan.yearUsd) * 100,
    type: "recurring",
    billing_scheme: "per_unit",
    recurring: { interval, interval_count: 1, usage_type: "licensed" },
    metadata: { product_line: "example-entitlements", plan: plan.key },
    product: {
      active: true,
      metadata: { product_line: "example-entitlements", plan: plan.key },
    },
  };
}

function packPrice(lookupKey: string): Record<string, unknown> {
  const pack = catalog
    .orderedCreditPacks()
    .find(
      (candidate) => catalog.creditPackLookupKey(candidate.key) === lookupKey,
    );
  if (pack === undefined) throw new Error("unexpected pack lookup");
  return {
    id: `price_${pack.key}`,
    active: true,
    lookup_key: lookupKey,
    currency: pack.currency,
    unit_amount: pack.priceUsd * 100,
    type: "one_time",
    billing_scheme: "per_unit",
    metadata: {
      product_line: "example-entitlements",
      credit_pack: pack.key,
    },
    product: {
      active: true,
      metadata: {
        product_line: "example-entitlements",
        credit_pack: pack.key,
      },
    },
  };
}

describe("TypeScript doctor local and read-only network closure", () => {
  test("passes complete local and database checks without any Stripe request", async () => {
    const calls: string[] = [];
    const network: DoctorStripeNetwork = {
      retrieveAccount: () => {
        calls.push("account");
        return Promise.reject(new Error("must not run"));
      },
      pricesForLookup: (lookupKey: string) => {
        calls.push(`price:${lookupKey}`);
        return Promise.reject(new Error("must not run"));
      },
      retrievePortalConfiguration: (configurationId: string) => {
        calls.push(`portal:${configurationId}`);
        return Promise.reject(new Error("must not run"));
      },
    };
    const report = await runDoctor({
      settings: settings(),
      database: postgresDatabase(),
      network,
    });
    const byName = new Map(report.checks.map((item) => [item.name, item]));

    expect(report.ok).toBe(true);
    expect(byName.get("catalog.load")?.status).toBe("pass");
    expect(byName.get("database.connection")?.status).toBe("pass");
    expect(byName.get("database.schema")?.status).toBe("pass");
    expect(byName.get("database.migration_checksums")?.status).toBe("pass");
    expect(byName.get("stripe.network")?.status).toBe("skipped");
    expect(calls).toEqual([]);
  });

  test("opts into only read-only Account, Price and Portal retrievals", async () => {
    const calls: string[] = [];
    const network: DoctorStripeNetwork = {
      retrieveAccount: () => {
        calls.push("account");
        return Promise.resolve({ id: "acct_doctor" });
      },
      pricesForLookup: (lookupKey: string) => {
        calls.push(`price:${lookupKey}`);
        return Promise.resolve([
          catalog.parseLookupKey(lookupKey) === undefined
            ? packPrice(lookupKey)
            : recurringPrice(lookupKey),
        ]);
      },
      retrievePortalConfiguration: (configurationId: string) => {
        calls.push("portal");
        return Promise.resolve({
          id: configurationId,
          active: true,
          livemode: false,
          metadata: { product_line: "example-entitlements" },
          features: {
            subscription_update: { enabled: false },
            subscription_cancel: { enabled: true, mode: "at_period_end" },
          },
        });
      },
    };
    const report = await runDoctor({
      settings: settings(),
      database: postgresDatabase(),
      stripeNetwork: true,
      network,
    });
    const byName = new Map(report.checks.map((item) => [item.name, item]));

    expect(report.ok).toBe(true);
    expect(byName.get("stripe.network.account")?.status).toBe("pass");
    expect(byName.get("stripe.network.catalog")?.status).toBe("pass");
    expect(byName.get("stripe.network.portal")?.status).toBe("pass");
    expect(calls[0]).toBe("account");
    expect(calls.at(-1)).toBe("portal");
    expect(calls.filter((value) => value.startsWith("price:"))).toHaveLength(
      catalog.plans.size * 2 + catalog.creditPacks.size,
    );
  });

  test("reports placeholder field names without rendering secret values", async () => {
    const values = settings({
      STRIPE_SECRET_KEY: "sk_test_replace_me_private_value",
      STRIPE_WEBHOOK_SECRET: "whsec_replace_me_private_value",
      STRIPE_PORTAL_CONFIGURATION_ID: "bpc_replace_me_private_value",
      DEMO_BEARER_TOKEN: "replace_with_local_random_value",
    });
    const report = await runDoctor({
      settings: values,
      database: postgresDatabase(),
    });
    const rendered = JSON.stringify(report.asObject());
    expect(report.ok).toBe(false);
    expect(rendered).toContain("STRIPE_SECRET_KEY");
    expect(rendered).toContain("STRIPE_WEBHOOK_SECRET");
    expect(rendered).toContain("DEMO_BEARER_TOKEN");
    expect(rendered).not.toContain(values.stripeSecretKey);
    expect(rendered).not.toContain(values.stripeWebhookSecret);
    expect(rendered).not.toContain(values.stripePortalConfigurationId);
  });
});
