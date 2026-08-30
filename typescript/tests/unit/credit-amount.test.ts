import { describe, expect, it } from "vitest";

import {
  CREDIT_SCALE,
  MAX_CREDIT_ATOMS,
  checkedAddAtoms,
  creditAtoms,
  creditDecimal,
} from "../../src/credit-amount.js";

describe("exact product credit protocol", () => {
  it.each([
    ["0", 0n],
    ["0.000001", 1n],
    ["0.1", 100_000n],
    ["0.100000", 100_000n],
    ["12.340500", 12_340_500n],
    [7, 7_000_000n],
    [7n, 7_000_000n],
  ])("parses %s without floating point", (value, expected) => {
    expect(creditAtoms(value)).toBe(expected);
  });

  it.each([
    -1,
    -1n,
    0.1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    true,
    null,
    "",
    "01",
    "+1",
    "-1",
    ".1",
    "1.",
    "1.0000000",
    "1e2",
    " 1",
  ])("rejects a non-canonical input %#", (value) => {
    expect(() => creditAtoms(value)).toThrow();
  });

  it("enforces the exact PostgreSQL bigint boundary", () => {
    expect(creditAtoms("9223372036854.775807")).toBe(MAX_CREDIT_ATOMS);
    expect(() => creditAtoms("9223372036854.775808")).toThrow(/bigint/u);
    expect(() => creditAtoms("9223372036855")).toThrow(/bigint/u);
    expect(() => creditAtoms("0", { allowZero: false })).toThrow(
      /greater than zero/u,
    );
  });

  it.each([
    [0n, "0"],
    [1n, "0.000001"],
    [100_000n, "0.1"],
    [CREDIT_SCALE, "1"],
    [12_340_500n, "12.3405"],
    [MAX_CREDIT_ATOMS, "9223372036854.775807"],
    [MAX_CREDIT_ATOMS * 2n, "18446744073709.551614"],
  ])("serializes %s canonically", (atoms, expected) => {
    expect(creditDecimal(atoms)).toBe(expected);
  });

  it("checks persisted additions without restricting read-only aggregates", () => {
    expect(checkedAddAtoms(1n, 2n)).toBe(3n);
    expect(() => checkedAddAtoms(MAX_CREDIT_ATOMS, 1n)).toThrow(/bigint/u);
    expect(creditDecimal(MAX_CREDIT_ATOMS * 2n)).toContain("18446744073709");
  });
});
