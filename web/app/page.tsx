import type { Metadata } from "next";
import Link from "next/link";
import { HeroSettlementCanvas } from "@/components/HeroSettlementCanvas";
import { ScrollReveal } from "@/components/ScrollReveal";
import { UpgradeMatrix } from "@/components/UpgradeMatrix";
import { annualSavings, formatMoney } from "@/lib/money";
import { referencePlans } from "@/lib/reference-catalog";
import {
  absoluteSiteUrl,
  publicSiteUrl,
  REPOSITORY_URL,
  serializeJsonLd,
  SITE_DESCRIPTION,
  SITE_NAME,
} from "@/lib/site";

export const metadata: Metadata = {
  title: "Stripe Billing & Entitlements Template for FastAPI",
  description:
    "An open-source Stripe subscription billing template with FastAPI, PostgreSQL entitlements, Next.js, and complete full-period or prorated upgrade policies.",
  alternates: absoluteSiteUrl(publicSiteUrl, "/")
    ? { canonical: absoluteSiteUrl(publicSiteUrl, "/") }
    : undefined,
};

// These titles feed the JSON-LD featureList; keep them keyword-meaningful.
const capabilities = [
  {
    title: "Race-safe Stripe webhooks",
    body: "PostgreSQL event inboxes, row locks, business idempotency keys, and deterministic out-of-order projection.",
  },
  {
    title: "Subscription entitlements",
    body: "Structured plan limits, monthly credit grants, annual funding slots, refunds, disputes, and grant-epoch-safe usage.",
  },
  {
    title: "Full-price or prorated upgrades",
    body: "Choose full_period_reset or prorated_delta. Both define a complete 6 × 6 monthly/yearly transition matrix with durable intent, SCA recovery, and refund convergence.",
  },
  {
    title: "Real Stripe test gates",
    body: "Test-mode API, Test Clock renewal, Playwright Checkout, decline, 3DS, signed webhook, and UI projection gates.",
  },
];

const pipelineSteps = [
  {
    step: "01 · Stripe",
    code: "checkout.session.completed",
    body: "Signature verified on the raw request body before any parsing.",
  },
  {
    step: "02 · Event inbox",
    code: "claimed exactly once",
    body: "Duplicate and out-of-order deliveries cannot double-apply.",
  },
  {
    step: "03 · PostgreSQL",
    code: "one transaction",
    body: "Row locks and idempotency keys apply every effect together.",
  },
  {
    step: "04 · Entitlements",
    code: "projected state",
    body: "Product code reads the database. The browser never grants access.",
  },
];

const testGates = [
  {
    key: "checkout",
    command: "stripe checkout · paid session",
    note: "a real test-mode purchase settles into credits",
  },
  {
    key: "decline",
    command: "card declined",
    note: "no entitlement changes; the retry path stays clean",
  },
  {
    key: "sca",
    command: "3-D Secure challenge",
    note: "SCA recovery completes and settles exactly once",
  },
  {
    key: "webhook",
    command: "signed webhook delivery",
    note: "signature checked on the exact raw body before parsing",
  },
  {
    key: "test-clock",
    command: "Test Clock renewal",
    note: "cross-period grants advance exactly once",
  },
  {
    key: "projection",
    command: "UI projection",
    note: "the account screen reads the database, never the browser",
  },
];

const frequentlyAskedQuestions = [
  {
    question: "Is this an official Stripe billing framework?",
    answer:
      "No. It is an independent, open-source reference implementation for a deliberately bounded single-item subscription and credit-entitlement policy.",
  },
  {
    question: "Does the template support monthly and annual subscriptions?",
    answer:
      "Yes. Starter, Pro, and Ultra each have monthly and annual prices. Annual invoices fund monthly credit slots, and an opt-in Stripe Test Clock gate covers cross-year renewal.",
  },
  {
    question: "Does it support Stripe prorated subscription upgrades?",
    answer:
      "Yes. The prorated-delta template accepts a paid two-line monthly upgrade Invoice, preserves the current period, and adds the fixed catalog entitlement difference. Annual and unsupported invoice shapes defer or fail closed.",
  },
  {
    question: "What do the two subscription change templates cover?",
    answer:
      "full_period_reset and prorated_delta each define all 36 source-to-target cells across three monthly and three yearly states. Annual-origin changes, interval changes under the delta policy, and downgrades remain period-end.",
  },
  {
    question: "How are annual savings calculated?",
    answer:
      "The UI compares twelve monthly payments with the explicit annual price in the same currency. It displays savings only when the annual total is lower.",
  },
  {
    question: "Are coupons, trials, tax, and multi-currency billing included?",
    answer:
      "No. Those policies are intentionally outside the implemented scope and are not advertised as supported behavior.",
  },
  {
    question: "Is the design safe for multiple API or worker instances?",
    answer:
      "Yes, when every instance shares one PostgreSQL primary. Database locks, constraints, leases, and idempotency provide coordination; PostgreSQL remains the writable truth.",
  },
];

const structuredData = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "SoftwareApplication",
      name: SITE_NAME,
      description: SITE_DESCRIPTION,
      applicationCategory: "DeveloperApplication",
      operatingSystem: "Any",
      isAccessibleForFree: true,
      license: "https://www.apache.org/licenses/LICENSE-2.0",
      codeRepository: REPOSITORY_URL,
      url: absoluteSiteUrl(publicSiteUrl, "/") ?? REPOSITORY_URL,
      programmingLanguage: ["Python", "TypeScript", "SQL"],
      featureList: capabilities.map((capability) => capability.title),
    },
    {
      "@type": "FAQPage",
      mainEntity: frequentlyAskedQuestions.map((item) => ({
        "@type": "Question",
        name: item.question,
        acceptedAnswer: { "@type": "Answer", text: item.answer },
      })),
    },
  ],
};

export default function HomePage() {
  return (
    <div className="landing-page">
      <script
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(structuredData) }}
        type="application/ld+json"
      />
      <ScrollReveal />

      <section aria-labelledby="hero-heading" className="landing-hero-plane">
        <HeroSettlementCanvas />
        <div className="shell hero-inner">
          <p className="hero-brand">
            <span aria-hidden="true" className="brand-mark" />
            <span>{SITE_NAME}</span>
            <span className="hero-brand-tag">Open-source reference</span>
          </p>
          <h1 id="hero-heading">
            Billing events are chaos. Your entitlements aren&rsquo;t.
          </h1>
          <p className="hero-support">
            An open-source Stripe billing reference for FastAPI, PostgreSQL, and
            Next.js that turns noisy webhook streams into deterministic access.
          </p>
          <div className="hero-actions">
            <Link className="button primary" href="/pricing">
              Explore the live demo
              <span aria-hidden="true" className="button-arrow">
                →
              </span>
            </Link>
            <a className="button secondary" href={REPOSITORY_URL}>
              View the source
            </a>
          </div>
        </div>
      </section>

      <section
        aria-labelledby="pipeline-heading"
        className="ink-band band-raised"
      >
        <div className="shell" data-reveal>
          <div className="section-heading">
            <p className="eyebrow">The pipeline</p>
            <h2 id="pipeline-heading">Signature to settlement in four steps.</h2>
          </div>
          <ol
            aria-label="How a Stripe event becomes an entitlement"
            className="pipeline-strip"
          >
            {pipelineSteps.map((item) => (
              <li key={item.step}>
                <span className="pipeline-step">
                  <span aria-hidden="true" className="pipeline-dot" />
                  {item.step}
                </span>
                <code>{item.code}</code>
                <p>{item.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section aria-labelledby="invariants-heading" className="ink-band">
        <div className="shell" data-reveal>
          <div className="section-heading">
            <p className="eyebrow">Guarantees, not features</p>
            <h2 id="invariants-heading">
              A Stripe billing reference built on invariants.
            </h2>
            <p>
              The browser never grants access. Signed events and PostgreSQL
              transactions project the subscription, entitlement, and credit
              state that product code enforces.
            </p>
          </div>
          <ol className="capability-list">
            {capabilities.map((capability, index) => (
              <li className="capability-item" key={capability.title}>
                <span aria-hidden="true" className="capability-index">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <div>
                  <h3>{capability.title}</h3>
                  <p>{capability.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section
        aria-labelledby="matrix-heading"
        className="ink-band band-raised"
      >
        <div className="shell" data-reveal>
          <div className="section-heading">
            <p className="eyebrow">The upgrade matrix</p>
            <h2 id="matrix-heading">All 36 plan transitions, defined.</h2>
            <p>
              Three plans, two intervals, no undefined cell. Every source state
              maps to every target state with an explicit outcome, so support
              never has to guess what an upgrade did to an invoice.
            </p>
          </div>
          <UpgradeMatrix />
        </div>
      </section>

      <section aria-labelledby="catalog-heading" className="ink-band">
        <div className="shell" data-reveal>
          <div className="section-heading">
            <p className="eyebrow">Bundled reference catalog</p>
            <h2 id="catalog-heading">Three tiers, monthly and annual billing.</h2>
            <p>
              Prices are explicit billing data. Stable plan rank controls
              upgrade and downgrade direction, while annual savings remain a
              display-only calculation.
            </p>
          </div>
          <div className="catalog-tiles">
            {referencePlans.map((plan) => {
              const saving = annualSavings(plan);
              const credits = plan.entitlements.find(
                (item) => item.key === "monthly_credits",
              )?.value;
              return (
                <div className="catalog-tile" key={plan.key}>
                  <h3>{plan.name}</h3>
                  <p className="catalog-price">
                    {formatMoney(
                      plan.prices.month.unit_amount,
                      plan.prices.month.currency,
                    )}
                    <span>/month</span>
                  </p>
                  <p className="catalog-credits">
                    {String(credits ?? "—")} credits per monthly grant
                  </p>
                  <p className="catalog-saving">
                    {saving === null
                      ? "No annual saving claimed"
                      : `Save ${formatMoney(saving, plan.prices.year.currency)} on annual billing`}
                  </p>
                </div>
              );
            })}
          </div>
          <p className="catalog-more">
            <Link href="/pricing">See the full pricing breakdown →</Link>
          </p>
          <div
            aria-label="Scrollable reference plan comparison"
            className="comparison-table-wrap"
            role="region"
            tabIndex={0}
          >
            <table className="comparison-table">
              <caption>
                Reference Stripe subscription plans and annual savings
              </caption>
              <thead>
                <tr>
                  <th scope="col">Plan</th>
                  <th scope="col">Monthly</th>
                  <th scope="col">Annual total</th>
                  <th scope="col">Annual saving</th>
                  <th scope="col">Monthly credits</th>
                </tr>
              </thead>
              <tbody>
                {referencePlans.map((plan) => {
                  const savings = annualSavings(plan);
                  const monthlyCredits = plan.entitlements.find(
                    (item) => item.key === "monthly_credits",
                  )?.value;
                  return (
                    <tr key={plan.key}>
                      <th scope="row">{plan.name}</th>
                      <td>
                        {formatMoney(
                          plan.prices.month.unit_amount,
                          plan.prices.month.currency,
                        )}
                      </td>
                      <td>
                        {formatMoney(
                          plan.prices.year.unit_amount,
                          plan.prices.year.currency,
                        )}
                      </td>
                      <td>
                        {savings === null
                          ? "No saving claimed"
                          : formatMoney(savings, plan.prices.year.currency)}
                      </td>
                      <td>{String(monthlyCredits ?? "—")}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="truth-note">
            This example does not claim coupons, trials, tax, multi-currency,
            seats, or metered billing. Adapt and test those policies before
            advertising them.
          </p>
        </div>
      </section>

      <section aria-labelledby="gates-heading" className="ink-band band-raised">
        <div className="shell" data-reveal>
          <div className="section-heading">
            <p className="eyebrow">Proof, not promises</p>
            <h2 id="gates-heading">Proven against real Stripe test mode.</h2>
            <p>
              Every advertised behavior has an automated gate that runs against
              the real Stripe test-mode API — not a mock of it.
            </p>
          </div>
          <ul className="gate-terminal">
            {testGates.map((gate) => (
              <li key={gate.key}>
                <span aria-hidden="true" className="gate-dot" />
                <code>{gate.command}</code>
                <span className="gate-note">{gate.note}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section aria-labelledby="faq-heading" className="ink-band">
        <div className="shell" data-reveal>
          <div className="section-heading">
            <p className="eyebrow">Frequently asked questions</p>
            <h2 id="faq-heading">Stripe billing template FAQ</h2>
          </div>
          <div className="faq-list">
            {frequentlyAskedQuestions.map((item) => (
              <details key={item.question}>
                <summary>{item.question}</summary>
                <p>{item.answer}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <section
        aria-labelledby="final-cta-heading"
        className="ink-band band-raised landing-final"
      >
        <div className="shell" data-reveal>
          <h2 id="final-cta-heading">Read the code. Run the gates.</h2>
          <p className="final-support">
            Clone the reference, point it at Stripe test mode, and watch chaotic
            events settle into deterministic entitlements.
          </p>
          <div className="final-actions">
            <a className="button primary" href={REPOSITORY_URL}>
              View the source
              <span aria-hidden="true" className="button-arrow">
                →
              </span>
            </a>
            <Link className="button secondary" href="/pricing">
              Explore the live demo
            </Link>
          </div>
          <p className="final-note">
            Apache-2.0 licensed. Reference UI only — Stripe and webhook state
            remain server-authoritative.
          </p>
        </div>
      </section>
    </div>
  );
}
