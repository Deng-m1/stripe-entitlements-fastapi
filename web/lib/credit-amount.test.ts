import { describe, expect, it } from "vitest";
import {
  CREDIT_SCALE,
  creditAmountFromAtoms,
  creditAmountFromDecimal,
  formatCreditDecimal,
  parseExactCreditAmount,
  subtractCreditDecimals,
} from "@/lib/credit-amount";

describe("exact credit amounts", () => {
  it.each([
    ["0", "0"],
    ["0.000001", "1"],
    ["300.5", "300500000"],
    ["1000", "1000000000"],
  ])("round-trips %s without floating-point arithmetic", (decimal, atoms) => {
    expect(creditAmountFromDecimal(decimal)).toEqual({
      decimal,
      atoms,
      scale: CREDIT_SCALE,
    });
    expect(creditAmountFromAtoms(atoms)).toEqual({
      decimal,
      atoms,
      scale: CREDIT_SCALE,
    });
    expect(parseExactCreditAmount(decimal, atoms, CREDIT_SCALE)).toEqual({
      decimal,
      atoms,
      scale: CREDIT_SCALE,
    });
  });

  it("preserves atoms above Number.MAX_SAFE_INTEGER", () => {
    const amount = creditAmountFromAtoms("9007199254740993");
    expect(amount.decimal).toBe("9007199254.740993");
    expect(amount.atoms).toBe("9007199254740993");
    expect(formatCreditDecimal(amount.decimal)).toBe("9,007,199,254.740993");
  });

  it("subtracts in atoms and retains the smallest supported fraction", () => {
    expect(subtractCreditDecimals("1000.000001", "300.5")).toBe(
      "699.500001",
    );
  });

  it("canonicalizes an exact catalog string with redundant trailing zeroes", () => {
    expect(creditAmountFromDecimal("300.500000")).toEqual({
      decimal: "300.5",
      atoms: "300500000",
      scale: CREDIT_SCALE,
    });
  });

  it.each([
    [0, "0", CREDIT_SCALE],
    ["0", 0, CREDIT_SCALE],
    ["0", "0", 1000],
    ["300.5", "300500001", CREDIT_SCALE],
    ["01", "1000000", CREDIT_SCALE],
    ["1.0", "1000000", CREDIT_SCALE],
    ["0.0000001", "0", CREDIT_SCALE],
  ])("rejects an invalid or lossy wire tuple", (decimal, atoms, scale) => {
    expect(() => parseExactCreditAmount(decimal, atoms, scale)).toThrow();
  });

  it("accepts an aggregate backed by multiple signed-bigint funding rows", () => {
    expect(
      parseExactCreditAmount(
        "18446744073709.551614",
        "18446744073709551614",
        CREDIT_SCALE,
      ),
    ).toEqual({
      decimal: "18446744073709.551614",
      atoms: "18446744073709551614",
      scale: CREDIT_SCALE,
    });
  });
});
