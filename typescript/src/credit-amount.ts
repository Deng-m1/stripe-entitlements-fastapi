import { POSTGRES_BIGINT_MAX } from "./bounds.js";

export const CREDIT_SCALE = 1_000_000n;
export const CREDIT_DECIMAL_PLACES = 6;
export const MAX_CREDIT_ATOMS = POSTGRES_BIGINT_MAX;
export const MAX_WHOLE_CREDITS = MAX_CREDIT_ATOMS / CREDIT_SCALE;

const PLAIN_DECIMAL = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,6}))?$/u;
const CREDIT_AMOUNT_INSTANCES = new WeakSet<object>();

export type CreditInput = string | number | bigint;

function plainDecimalText(value: unknown, field: string): string {
  if (typeof value === "bigint") {
    if (value < 0n) {
      throw new RangeError(`${field} must be non-negative`);
    }
    return value.toString();
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(
        `${field} must be a non-negative safe integer or decimal string`,
      );
    }
    return value.toString();
  }
  if (typeof value === "string") {
    return value;
  }
  throw new TypeError(`${field} must be an integer or plain decimal string`);
}

export function creditAtoms(
  value: unknown,
  options: { readonly field?: string; readonly allowZero?: boolean } = {},
): bigint {
  const field = options.field ?? "credit amount";
  const allowZero = options.allowZero ?? true;
  const text = plainDecimalText(value, field);
  const match = PLAIN_DECIMAL.exec(text);
  if (match === null) {
    throw new RangeError(
      `${field} must be a non-negative plain decimal with at most ${CREDIT_DECIMAL_PLACES} fractional digits`,
    );
  }
  const wholeText = match[1];
  if (wholeText === undefined) {
    throw new RangeError(`${field} is invalid`);
  }
  const whole = BigInt(wholeText);
  if (whole > MAX_WHOLE_CREDITS) {
    throw new RangeError(`${field} exceeds the PostgreSQL bigint atom range`);
  }
  const fractionalText = (match[2] ?? "").padEnd(CREDIT_DECIMAL_PLACES, "0");
  const atoms = whole * CREDIT_SCALE + BigInt(fractionalText || "0");
  if (atoms > MAX_CREDIT_ATOMS) {
    throw new RangeError(`${field} exceeds the PostgreSQL bigint atom range`);
  }
  if (!allowZero && atoms === 0n) {
    throw new RangeError(`${field} must be greater than zero`);
  }
  return atoms;
}

export function creditDecimal(atoms: bigint, field = "credit atoms"): string {
  if (typeof atoms !== "bigint" || atoms < 0n) {
    throw new TypeError(`${field} must be a non-negative bigint`);
  }
  const whole = atoms / CREDIT_SCALE;
  const fractional = atoms % CREDIT_SCALE;
  if (fractional === 0n) {
    return whole.toString();
  }
  const padded = fractional.toString().padStart(CREDIT_DECIMAL_PLACES, "0");
  return `${whole.toString()}.${padded.replace(/0+$/u, "")}`;
}

export function checkedAddAtoms(
  left: bigint,
  right: bigint,
  field = "credit balance",
): bigint {
  if (
    typeof left !== "bigint" ||
    typeof right !== "bigint" ||
    left < 0n ||
    right < 0n ||
    left > MAX_CREDIT_ATOMS ||
    right > MAX_CREDIT_ATOMS
  ) {
    throw new RangeError(
      `${field} operands must be non-negative PostgreSQL bigint values`,
    );
  }
  if (left > MAX_CREDIT_ATOMS - right) {
    throw new RangeError(`${field} exceeds the PostgreSQL bigint atom range`);
  }
  return left + right;
}

export class CreditAmount {
  public readonly atoms: bigint;

  public constructor(atoms: bigint) {
    if (typeof atoms !== "bigint" || atoms < 0n) {
      throw new RangeError("credit atoms must be a non-negative bigint");
    }
    this.atoms = atoms;
    CREDIT_AMOUNT_INSTANCES.add(this);
  }

  public static isCreditAmount(value: unknown): value is CreditAmount {
    return (
      typeof value === "object" &&
      value !== null &&
      CREDIT_AMOUNT_INSTANCES.has(value)
    );
  }

  public static parse(
    value: unknown,
    options: { readonly field?: string; readonly allowZero?: boolean } = {},
  ): CreditAmount {
    return new CreditAmount(creditAtoms(value, options));
  }

  public static fromAtoms(atoms: bigint): CreditAmount {
    return new CreditAmount(atoms);
  }

  public toString(): string {
    return creditDecimal(this.atoms);
  }
}
