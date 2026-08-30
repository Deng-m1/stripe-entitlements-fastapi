import { describe, expect, it } from "vitest";

import {
  RejectAllWorkloadIdentityAdapter,
  RejectAllWorkloadOwnerAuthorizer,
  WorkloadAuthenticationError,
  WorkloadAuthorizationError,
  WorkloadPrincipal,
} from "../../src/internal-auth.js";

function principal(
  overrides: Partial<ConstructorParameters<typeof WorkloadPrincipal>[0]> = {},
): WorkloadPrincipal {
  return new WorkloadPrincipal({
    issuer: "https://workloads.example.test/",
    subject: "job-runner",
    scopes: new Set(["entitlements:check", "credits:charge", "credits:refund"]),
    ...overrides,
  });
}

describe("workload principal", () => {
  it("stores a bounded verified issuer, subject, and immutable scope set", () => {
    const value = principal();
    expect(value.issuer).toBe("https://workloads.example.test/");
    expect(value.subject).toBe("job-runner");
    expect([...value.scopes]).toEqual([
      "entitlements:check",
      "credits:charge",
      "credits:refund",
    ]);
    expect(value.scopes.size).toBe(3);
    expect([...value.scopes.keys()]).toEqual([...value.scopes.values()]);
    expect([...value.scopes.entries()][0]).toEqual([
      "entitlements:check",
      "entitlements:check",
    ]);
    const visited: string[] = [];
    value.scopes.forEach((scope, duplicate, set) => {
      expect(duplicate).toBe(scope);
      expect(set).toBe(value.scopes);
      visited.push(scope);
    });
    expect(visited).toEqual([...value.scopes]);
    expect(Object.prototype.toString.call(value.scopes)).toBe(
      "[object ImmutableScopes]",
    );
    expect(Object.isFrozen(value)).toBe(true);
    expect(() =>
      (value.scopes as Set<string>).add("admin:everything"),
    ).toThrow();
    expect(value.scopes.has("admin:everything")).toBe(false);
  });

  it.each([
    { issuer: "" },
    { issuer: " padded" },
    { issuer: "line\nbreak" },
    { issuer: "x".repeat(513) },
    { subject: "" },
    { subject: " padded" },
    { subject: "line\u0000break" },
    { subject: "x".repeat(513) },
  ])("rejects invalid identity field %#", (override) => {
    expect(() => principal(override)).toThrow("workload principal");
  });

  it("requires a real Set rather than trusting an arbitrary iterable", () => {
    expect(() =>
      principal({
        scopes: ["credits:charge"] as unknown as ReadonlySet<string>,
      }),
    ).toThrow("scopes must be a Set");
  });

  it.each([
    "",
    "UPPER",
    "1starts-with-number",
    "contains space",
    "contains.dot",
    `a${"x".repeat(128)}`,
  ])("rejects invalid scope %#", (scope) => {
    expect(() => principal({ scopes: new Set([scope]) })).toThrow(
      "scopes are invalid",
    );
  });

  it("rejects more than 64 scopes", () => {
    const scopes = new Set(
      Array.from({ length: 65 }, (_, index) => `scope:${String(index)}`),
    );
    expect(() => principal({ scopes })).toThrow("scopes are invalid");
  });
});

describe("workload fail-closed adapters", () => {
  it("rejects all credentials until a host identity adapter is configured", async () => {
    await expect(
      new RejectAllWorkloadIdentityAdapter().authenticate(
        new Request("https://billing.example.test/internal/entitlements/check"),
      ),
    ).rejects.toBeInstanceOf(WorkloadAuthenticationError);
  });

  it("does not let a valid operation scope authorize an owner", async () => {
    const workload = principal({ scopes: new Set(["credits:charge"]) });
    await expect(
      new RejectAllWorkloadOwnerAuthorizer().authorize(
        workload,
        "v1:tenant:88a213a7-3424-4260-b964-fd082d776b10",
        "credits:charge",
      ),
    ).rejects.toBeInstanceOf(WorkloadAuthorizationError);
  });

  it("rejects cross-tenant ownership even when the workload has every known scope", async () => {
    const workload = principal();
    const authorizer = new RejectAllWorkloadOwnerAuthorizer();
    await expect(
      authorizer.authorize(
        workload,
        "v1:tenant:dd5163d1-c81c-48e7-8668-f62629c2bc21",
        "credits:refund",
      ),
    ).rejects.toThrow("no workload owner authorizer is configured");
  });
});
