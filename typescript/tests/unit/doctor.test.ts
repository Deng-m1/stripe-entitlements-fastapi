import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  runDoctor,
  TYPESCRIPT_PACKAGE_VERSION,
  type DoctorProfile,
} from "../../src/doctor.js";

describe("TypeScript doctor fail-closed reporting", () => {
  it("keeps runtime and npm artifact versions aligned", async () => {
    const packageJson = JSON.parse(
      // The path is a checked-in literal rooted at this test file.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      await readFile(
        resolve(import.meta.dirname, "../../package.json"),
        "utf8",
      ),
    ) as { readonly version?: string };

    expect(TYPESCRIPT_PACKAGE_VERSION).toBe(packageJson.version);
  });

  it("redacts configuration exception details and emits a complete skipped tail", async () => {
    const report = await runDoctor({
      environment: {
        STRIPE_SECRET_KEY: "sk_live_must_never_be_rendered",
        STRIPE_WEBHOOK_SECRET: "whsec_must_never_be_rendered",
      },
    });
    const rendered = JSON.stringify(report.asObject());
    expect(report.ok).toBe(false);
    expect(rendered).toContain("ConfigurationError");
    expect(rendered).toContain("DATABASE_URL is required");
    expect(rendered).not.toContain("sk_live_must_never_be_rendered");
    expect(rendered).not.toContain("whsec_must_never_be_rendered");
    expect(
      report.checks.find((item) => item.name === "database.schema")?.status,
    ).toBe("skipped");
    expect(
      report.checks.find((item) => item.name === "stripe.network")?.status,
    ).toBe("skipped");
  });

  it.each(["full", "unknown"])(
    "rejects unsupported profile %s before loading configuration",
    async (profile) => {
      await expect(
        runDoctor({ profile: profile as DoctorProfile }),
      ).rejects.toThrow("doctor profile");
    },
  );
});
