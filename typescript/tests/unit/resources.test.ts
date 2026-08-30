import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  defaultMigrationDirectory,
  defaultPlanCatalogPath,
} from "../../src/resources.js";

describe("packaged resource discovery", () => {
  it("finds the canonical source plan catalog", async () => {
    const catalog = defaultPlanCatalogPath();
    expect(basename(catalog)).toBe("plans.toml");
    // The locator returns only an existing bounded package/source candidate.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const text = await readFile(catalog, "utf8");
    expect(text).toContain("[plans.starter]");
    expect(text).toContain("[plans.ultra]");
  });

  it("finds the byte-identical migration bundle", async () => {
    for (const [filename, expected] of [
      [
        "001_v3_baseline.sql",
        "8db1d8dec549a9a06148d0df3d73d7e3880dd77858cf1a13cff8837a45b07e11",
      ],
      [
        "002_stripe_request_snapshots.sql",
        "052b9ed201c19621a2bf9230b1e5c1eca6ba5dba6be760a5ac40ce40b7289e13",
      ],
    ] as const) {
      // The locator returns only an existing bounded package/source candidate.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const payload = await readFile(
        resolve(defaultMigrationDirectory(), filename),
      );
      expect(createHash("sha256").update(payload).digest("hex")).toBe(expected);
    }
  });
});
