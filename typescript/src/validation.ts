export function isPlainRecord(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isPrintable(value: string): boolean {
  return [...value].every(
    (character) =>
      character === " " ||
      (!/\p{C}/u.test(character) && !/\p{Z}/u.test(character)),
  );
}

export function requiredVisibleString(
  value: unknown,
  field: string,
  maxBytes: number,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    Buffer.byteLength(value, "utf8") > maxBytes ||
    !isPrintable(value)
  ) {
    throw new TypeError(
      `${field} must be a non-empty visible string up to ${maxBytes} bytes`,
    );
  }
  return value;
}

export function requiredSafeInteger(
  value: unknown,
  field: string,
  minimum = 1,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const normalized =
    typeof value === "bigint" && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value;
  if (
    typeof normalized !== "number" ||
    !Number.isSafeInteger(normalized) ||
    normalized < minimum ||
    normalized > maximum
  ) {
    throw new RangeError(
      `${field} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return normalized;
}
