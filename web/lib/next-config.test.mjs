import nextConfig, {
  validatePublicBillingBuildEnvironment,
} from "../next.config.mjs";


describe("Next.js public billing build boundary", () => {
  it.each([
    ["production", "mock", undefined],
    ["production", "http", "browser-visible-token"],
    ["production", undefined, "browser-visible-token"],
  ])("rejects production demo configuration", (environment, mode, token) => {
    expect(() =>
      validatePublicBillingBuildEnvironment(environment, mode, token),
    ).toThrow(/Production builds cannot include/);
  });

  it.each(["MOCK", "production", "htp"])(
    "rejects an unknown public billing mode: %s",
    (mode) => {
      expect(() =>
        validatePublicBillingBuildEnvironment("development", mode, undefined),
      ).toThrow(/must be either 'http' or 'mock'/);
    },
  );

  it("allows explicit HTTP production and local mock development", () => {
    expect(() =>
      validatePublicBillingBuildEnvironment("production", "http", undefined),
    ).not.toThrow();
    expect(() =>
      validatePublicBillingBuildEnvironment("development", "mock", "local-token"),
    ).not.toThrow();
  });
});


describe("Next.js security headers", () => {
  it("applies the clickjacking, MIME, referrer, and permission boundaries globally", async () => {
    const rules = await nextConfig.headers();
    expect(rules).toHaveLength(1);
    expect(rules[0].source).toBe("/:path*");
    const headers = new Map(
      rules[0].headers.map(({ key, value }) => [key.toLowerCase(), value]),
    );

    expect(headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(headers.get("content-security-policy")).toContain("base-uri 'self'");
    expect(headers.get("content-security-policy")).toContain("object-src 'none'");
    expect(headers.get("x-frame-options")).toBe("DENY");
    expect(headers.get("x-content-type-options")).toBe("nosniff");
    expect(headers.get("referrer-policy")).toBe(
      "strict-origin-when-cross-origin",
    );
    expect(headers.get("permissions-policy")).toContain("camera=()");
    expect(headers.get("permissions-policy")).toContain("microphone=()");
    expect(headers.get("permissions-policy")).toContain("geolocation=()");
  });
});
