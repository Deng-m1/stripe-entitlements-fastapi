# Exact fractional product credits

The reference supports fractional product credits without storing binary floating-point
values. This document defines the public amount protocol and the boundary between product
credits and Stripe currency.

## Protocol

```text
credit scale       = 1,000,000 atoms per credit
minimum amount     = 0.000001 credit
database authority = signed PostgreSQL bigint atoms
Python boundary    = CreditAmount / Decimal, never float
HTTP boundary      = canonical decimal string plus atom string
```

The scale is part of the package and schema contract. It cannot be changed through an
environment variable. All replicas connected to one database therefore interpret a row
identically.

Examples:

| Public value | Stored atoms |
| --- | ---: |
| `1.000000` | `1000000` |
| `0.125000` | `125000` |
| `0.000001` | `1` |

Catalog integers retain their human meaning, so `monthly_credits = 300` means 300
credits. A fractional catalog value must be a TOML string:

```toml
monthly_credits = "300.500000"
```

TOML floats are rejected because they have already passed through a binary
floating-point representation before application validation.

## HTTP representation

Account credit fields expose exact values without relying on JavaScript's safe-integer
range:

```json
{
  "credits": {
    "balance": "299.875",
    "balance_atoms": "299875000",
    "grant_amount": "300.5",
    "grant_amount_atoms": "300500000",
    "scale": 1000000
  }
}
```

Requests that charge credits use decimal strings. Responses may be formatted for display,
and the backend emits a minimal canonical form without redundant trailing zeroes. Business
comparisons and arithmetic use atom strings or the validated amount helper.
Scientific notation, booleans, JSON fractional numbers, NaN, infinity, negative zero,
more than six fractional digits and overflowing values fail closed.

## Currency is not credit

Stripe prices, Invoice totals, refunds, proration credits and customer-balance amounts
remain Stripe currency minor-unit integers. Fields such as
`billing_funding_allocations.source_credit_amount` describe a cash credit on an Invoice;
they are not product credits and are never multiplied by the product-credit scale.

Product-credit atom fields include account balances, subscription grants, ledger deltas,
usage debits, entitlement deltas, refunded entitlement units and clawback debts. Database
column comments make this distinction explicit.

## Arithmetic and idempotency

- Normalize a public amount to atoms before comparing idempotency parameters.
- Use account row locking before checking and changing spendable atoms.
- Check `bigint` bounds before every addition or multiplication result is written.
- Compute cumulative refund withdrawal as
  `ceil(entitlement_atoms * amount_refunded_minor / amount_paid_minor)`.
- Never silently round a customer or catalog amount to the nearest atom.
- Log the canonical credit string and, when useful, the atom count with an explicit
  `_atoms` label.

These rules extend the existing grant, epoch, refund-order and clawback-debt invariants;
they do not relax them.
