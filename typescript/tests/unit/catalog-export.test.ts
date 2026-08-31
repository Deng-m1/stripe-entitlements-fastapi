import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { buildPublicReferenceCatalog } from "../../src/build/sync-reference-catalog.js";

describe("public reference catalog export", () => {
  it("derives the checked-in SEO snapshot from the validated TOML catalog", async () => {
    const repositoryRoot = resolve(import.meta.dirname, "../../..");
    const generated = await buildPublicReferenceCatalog(
      resolve(repositoryRoot, "plans.toml"),
    );
    const snapshotPath = resolve(repositoryRoot, "web/reference-catalog.json");
    // The path is a checked-in literal rooted at this test file.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const observed: unknown = JSON.parse(await readFile(snapshotPath, "utf8"));

    expect(generated).toEqual(observed);
  });
});
