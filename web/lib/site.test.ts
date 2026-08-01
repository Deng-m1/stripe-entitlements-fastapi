import { describe, expect, it } from "vitest";
import {
  absoluteSiteUrl,
  parsePublicSiteUrl,
  serializeJsonLd,
  shouldAllowIndexing,
} from "@/lib/site";

describe("public SEO configuration", () => {
  it("accepts an HTTPS origin and builds absolute URLs", () => {
    const site = parsePublicSiteUrl("https://billing.example.com", "production");

    expect(site?.origin).toBe("https://billing.example.com");
    expect(absoluteSiteUrl(site, "/pricing")).toBe(
      "https://billing.example.com/pricing",
    );
  });

  it("allows loopback HTTP only outside production", () => {
    expect(parsePublicSiteUrl("http://127.0.0.1:3000", "development")?.port).toBe(
      "3000",
    );
    expect(() =>
      parsePublicSiteUrl("http://127.0.0.1:3000", "production"),
    ).toThrow(/HTTPS/);
  });

  it.each([
    "https://user:secret@example.com",
    "https://example.com/app",
    "https://example.com?preview=1",
    "https://example.com#fragment",
  ])("rejects a non-origin public URL: %s", (value) => {
    expect(() => parsePublicSiteUrl(value, "production")).toThrow(/origin/);
  });

  it("requires an explicit production opt-in before indexing", () => {
    const site = new URL("https://billing.example.com");

    expect(shouldAllowIndexing("true", site, "production")).toBe(true);
    expect(shouldAllowIndexing("false", site, "production")).toBe(false);
    expect(shouldAllowIndexing("true", site, "development")).toBe(false);
    expect(shouldAllowIndexing("true", null, "production")).toBe(false);
  });

  it("escapes less-than signs in JSON-LD script content", () => {
    expect(serializeJsonLd({ value: "</script>" })).toBe(
      '{"value":"\\u003c/script>"}',
    );
  });
});
