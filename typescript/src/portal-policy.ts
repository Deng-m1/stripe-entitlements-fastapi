function isSupportedRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  try {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== null && prototype !== Object.prototype) {
      return false;
    }
    return Reflect.ownKeys(value).every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return (
        typeof key === "string" &&
        descriptor !== undefined &&
        descriptor.enumerable &&
        "value" in descriptor
      );
    });
  } catch {
    return false;
  }
}

export interface PortalConfigurationExpectation {
  readonly expectedLivemode: boolean;
  readonly expectedProductLine: string;
}

/** Verify the Portal configuration cannot bypass the service transition policy. */
export function portalConfigurationIsSafe(
  config: unknown,
  expected: PortalConfigurationExpectation,
): boolean {
  if (
    !isSupportedRecord(config) ||
    typeof expected.expectedLivemode !== "boolean" ||
    typeof expected.expectedProductLine !== "string"
  ) {
    return false;
  }
  const features = config["features"];
  const metadata = config["metadata"];
  if (!isSupportedRecord(features) || !isSupportedRecord(metadata)) {
    return false;
  }
  const cancel = features["subscription_cancel"];
  const update = features["subscription_update"];
  if (!isSupportedRecord(cancel) || !isSupportedRecord(update)) {
    return false;
  }

  // Other Portal capabilities and future feature keys are deliberately benign.
  return (
    config["active"] === true &&
    config["livemode"] === expected.expectedLivemode &&
    metadata["product_line"] === expected.expectedProductLine &&
    update["enabled"] === false &&
    cancel["enabled"] === true &&
    cancel["mode"] === "at_period_end"
  );
}
