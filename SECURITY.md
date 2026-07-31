# Security policy

Please report vulnerabilities privately through GitHub Security Advisories. Do not open a
public issue containing credentials, customer data, raw webhook payloads, or an exploitable
proof of concept against a live deployment.

This reference handles entitlement state, not card data. Keep card collection in Stripe
Checkout or Elements. Verify raw-body signatures, use least-privilege infrastructure,
rotate leaked secrets immediately, and restrict operational incident access.

Only the latest tagged minor release receives security fixes during the 0.x phase.
