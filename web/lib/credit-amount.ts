import type {
  CreditAtomsString,
  CreditDecimalString,
  CreditScale,
  Entitlement,
} from "@/lib/types";

export const CREDIT_SCALE: CreditScale = 1_000_000;

const FRACTION_DIGITS = 6;
const CANONICAL_ATOMS = /^(?:0|[1-9]\d*)$/u;
const EXACT_DECIMAL_INPUT = /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u;

export interface ExactCreditAmount {
  decimal: CreditDecimalString;
  atoms: CreditAtomsString;
  scale: CreditScale;
}

export class CreditAmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CreditAmountError";
  }
}

function parseAtoms(value: unknown): bigint {
  if (typeof value !== "string" || !CANONICAL_ATOMS.test(value)) {
    throw new CreditAmountError(
      "Credit atoms must be a canonical non-negative integer string.",
    );
  }
  const atoms = BigInt(value);
  return atoms;
}

function atomsFromDecimal(value: unknown): bigint {
  if (typeof value !== "string" || !EXACT_DECIMAL_INPUT.test(value)) {
    throw new CreditAmountError(
      "Credit value must be a non-negative plain decimal string with at most six fractional digits.",
    );
  }
  const [whole, fraction = ""] = value.split(".");
  const atoms =
    BigInt(whole) * BigInt(CREDIT_SCALE) +
    BigInt(fraction.padEnd(FRACTION_DIGITS, "0") || "0");
  return atoms;
}

function decimalFromAtoms(atoms: bigint): CreditDecimalString {
  const whole = atoms / BigInt(CREDIT_SCALE);
  const remainder = atoms % BigInt(CREDIT_SCALE);
  if (remainder === 0n) return whole.toString();
  const fraction = remainder
    .toString()
    .padStart(FRACTION_DIGITS, "0")
    .replace(/0+$/u, "");
  return `${whole}.${fraction}`;
}

export function parseExactCreditAmount(
  decimal: unknown,
  atomsValue: unknown,
  scale: unknown,
): ExactCreditAmount {
  if (scale !== CREDIT_SCALE) {
    throw new CreditAmountError(`Credit scale must be exactly ${CREDIT_SCALE}.`);
  }
  const atoms = parseAtoms(atomsValue);
  const decimalAtoms = atomsFromDecimal(decimal);
  const canonicalDecimal = decimalFromAtoms(atoms);
  if (decimalAtoms !== atoms || canonicalDecimal !== decimal) {
    throw new CreditAmountError("Credit decimal and atoms do not describe the same value.");
  }
  return {
    decimal: canonicalDecimal,
    atoms: atoms.toString(),
    scale: CREDIT_SCALE,
  };
}

export function creditAmountFromDecimal(decimal: string): ExactCreditAmount {
  const atoms = atomsFromDecimal(decimal);
  return {
    decimal: decimalFromAtoms(atoms),
    atoms: atoms.toString(),
    scale: CREDIT_SCALE,
  };
}

export function creditAmountFromAtoms(atomsValue: string): ExactCreditAmount {
  const atoms = parseAtoms(atomsValue);
  return {
    decimal: decimalFromAtoms(atoms),
    atoms: atoms.toString(),
    scale: CREDIT_SCALE,
  };
}

export function creditAmountFromEntitlement(
  entitlement: Pick<Entitlement, "key" | "value" | "value_atoms" | "scale">,
): ExactCreditAmount {
  if (entitlement.key !== "monthly_credits") {
    throw new CreditAmountError("Entitlement is not a monthly credit amount.");
  }
  return parseExactCreditAmount(
    entitlement.value,
    entitlement.value_atoms,
    entitlement.scale,
  );
}

export function formatCreditDecimal(decimal: string): string {
  const amount = creditAmountFromDecimal(decimal);
  const [whole, fraction] = amount.decimal.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
  return fraction ? `${grouped}.${fraction}` : grouped;
}

export function isZeroCreditDecimal(decimal: string): boolean {
  return atomsFromDecimal(decimal) === 0n;
}

export function subtractCreditDecimals(
  minuend: string,
  subtrahend: string,
): CreditDecimalString {
  const difference = atomsFromDecimal(minuend) - atomsFromDecimal(subtrahend);
  if (difference < 0n) {
    throw new CreditAmountError("Credit subtraction cannot produce a negative value.");
  }
  return decimalFromAtoms(difference);
}

export function addCreditDecimals(
  left: string,
  right: string,
): ExactCreditAmount {
  const sum = atomsFromDecimal(left) + atomsFromDecimal(right);
  return creditAmountFromAtoms(sum.toString());
}
