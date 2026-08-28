# SEO and public-discovery runbook

This repository has two discovery surfaces with different jobs:

1. GitHub and package metadata help developers find the open-source Stripe billing
   reference.
2. The Next.js reference site provides an indexable landing page and pricing example
   when a maintainer deliberately enables indexing on one canonical HTTPS origin.

SEO copy must remain inside the implemented scope. The project may describe three
monthly/yearly tiers, annual savings, exact fractional credits, one-time credit packs,
source-aware refunds, disputes, SCA, Test Clock renewal, and safe plan changes. It must
not claim coupons, trials, tax, multi-currency, seats, or metered billing unless those
policies are implemented and tested first.

Coupons and promotion codes are not implemented: Checkout omits
`allow_promotion_codes` unconditionally and discounted Invoices fail closed. Public
copy must never suggest that promo-code payment is supported;
[Promotion codes and coupons](PROMOTION_CODES.md) records the future gates that must
ship before that claim can change.

The site may describe both implemented transition templates: full-price period reset and
bounded same-period monthly prorated-delta upgrades. Copy must state that annual
transitions, discounts, tax, credit notes, and customer-balance funding are not handled
by the delta reducer.

Use the stable policy names `full_period_reset` and `prorated_delta` in technical copy,
and explain that each defines all 36 cells across Starter/Pro/Ultra monthly/yearly
states. Do not turn “tests exist” into “Stripe was verified”: current local evidence,
opt-in test-mode network evidence, historical runs, and live-production evidence must
remain visibly separate.

## Canonical deployment configuration

Preview, local, and staging deployments fail closed to `noindex`. Enable public indexing
only on the canonical production frontend:

```env
NEXT_PUBLIC_SITE_URL=https://billing.example.com
NEXT_PUBLIC_ALLOW_INDEXING=true
```

`NEXT_PUBLIC_SITE_URL` must be an HTTPS origin with no path, credentials, query, or
fragment. Loopback HTTP is accepted only outside production. Indexing requires all
three conditions: the explicit flag, a valid HTTPS origin, and `NODE_ENV=production`.

| Route | Index policy | Reason |
| --- | --- | --- |
| `/` | index when explicitly enabled | Server-rendered project landing and FAQ |
| `/pricing` | index when explicitly enabled | Reference monthly/yearly catalog |
| `/account` | always noindex | Authenticated account state |
| `/billing/success` | always noindex | User-specific payment return state |
| `/billing/error` | always noindex | User-specific error state |

The deployment generates `robots.txt`, `sitemap.xml`, a web manifest, canonical URLs,
Open Graph/Twitter images, and JSON-LD for the visible software/FAQ content. When
indexing is not enabled, `robots.txt` disallows the entire site and root metadata emits
`noindex,nofollow`.

## Content and catalog truth

The public landing and initial server-rendered pricing HTML use
`web/reference-catalog.json` through `web/lib/reference-catalog.ts`. The interactive UI
replaces it with the authenticated backend catalog after hydration. When adapting the
bundled example, update `plans.toml` and `web/reference-catalog.json` together. A backend
test fails if their names, descriptions, prices, features, limits, or plan order drift.
Never let static SEO content advertise a price or entitlement that the billing catalog
does not enforce.

Annual savings are calculated from explicit same-currency prices:

```text
annual saving = monthly unit amount × 12 − annual unit amount
```

A saving appears only when the result is positive. Price never determines tier rank or
transition timing.

## GitHub discovery

Before publishing, apply the description and topics recorded in
`.github/REPOSITORY_METADATA.md`. The README title and first paragraph intentionally use
natural developer search phrases such as “Stripe subscription billing”, “FastAPI Stripe
integration”, “PostgreSQL entitlements”, “fractional credit ledger”, “Stripe credit
packs”, and “Next.js pricing” without hiding scope limits or stuffing keywords.

The public title/description/FAQ should naturally cover the two selectable plan-change
templates, monthly and yearly tiers, positive annual-savings display, Stripe webhooks,
SCA, fixed-price packs, and Test Clock gates. Avoid asserting that a gate passed unless
the release record belongs to the exact published commit.

After the repository exists:

1. verify every badge and repository URL resolves;
2. enable the documented topics, About description, license, and security features;
3. publish a redacted architecture image or social preview only if it matches current
   behavior;
4. link the canonical demo from the GitHub About section;
5. submit the canonical sitemap to the relevant search consoles after production is
   stable.

## Verification

Run a production build with an inert documentation origin:

```bash
cd web
NEXT_PUBLIC_SITE_URL=https://billing.example.test \
NEXT_PUBLIC_ALLOW_INDEXING=true \
npm run build
```

Then run:

```bash
npm run lint
npm run typecheck
npm test
```

For a deployed canonical site, privately verify:

```text
GET /robots.txt
GET /sitemap.xml
GET /manifest.webmanifest
GET /
GET /pricing
```

Confirm canonical URLs use exactly one origin, sensitive routes remain `noindex`, JSON-LD
matches visible copy, social images return `image/png`, and the initial HTML contains
the landing content and reference plan names without requiring JavaScript.
