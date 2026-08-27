const sha256SpkiPattern = /^[A-Za-z0-9+/]{43}=$/u;

export function optionalLoopbackCertificateSpki(
  raw: string | undefined,
): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (!sha256SpkiPattern.test(value)) {
    throw new Error(
      "E2E_LOOPBACK_TLS_SPKI must be one base64-encoded SHA-256 SPKI pin.",
    );
  }
  return value;
}
