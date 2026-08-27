import { describe, expect, it } from "vitest";
import { optionalLoopbackCertificateSpki } from "@/lib/e2e-tls";

describe("real browser loopback TLS pin", () => {
  const validPin = `${"A".repeat(43)}=`;

  it("accepts one SHA-256 SPKI pin and treats absence as trusted TLS", () => {
    expect(optionalLoopbackCertificateSpki(validPin)).toBe(validPin);
    expect(optionalLoopbackCertificateSpki(undefined)).toBeUndefined();
    expect(optionalLoopbackCertificateSpki(" ")).toBeUndefined();
  });

  it("rejects lists, flags, malformed base64, and wrong digest lengths", () => {
    expect(() => optionalLoopbackCertificateSpki(`${validPin},${validPin}`)).toThrow(
      /one base64-encoded/,
    );
    expect(() =>
      optionalLoopbackCertificateSpki(`--ignore-certificate-errors=${validPin}`),
    ).toThrow(/one base64-encoded/);
    expect(() => optionalLoopbackCertificateSpki("_".repeat(43) + "=")).toThrow(
      /one base64-encoded/,
    );
    expect(() => optionalLoopbackCertificateSpki("A".repeat(44))).toThrow(
      /one base64-encoded/,
    );
  });
});
