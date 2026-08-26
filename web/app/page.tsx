import type { Metadata } from "next";
import Link from "next/link";
import {
  annualEquivalentMonthly,
  annualSavings,
  formatMoney,
} from "@/lib/money";
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

      <section aria-labelledby="hero-heading" className="landing-hero-plane">
        <div className="shell hero-inner">
          <p className="hero-brand">
            <span aria-hidden="true" className="brand-mark" />
            <span>{SITE_NAME}</span>
            <span className="hero-brand-tag">Open-source reference</span>
          </p>
          <h1 id="hero-heading">
            Race-safe Stripe billing for FastAPI, PostgreSQL, and Next.js.
          </h1>
          <p className="hero-support">
            A production-minded SaaS billing reference for subscriptions, credit
            entitlements, annual renewals, full-price or prorated upgrades, refunds,
            SCA recovery, and webhook-authoritative access.
          </p>
          <div className="hero-actions">
            <Link className="button primary" href="/pricing">
              Explore the pricing reference
              <span aria-hidden="true" className="button-arrow">
                →
              </span>
            </Link>
            <a className="button secondary" href={REPOSITORY_URL}>
              View the source on GitHub
            </a>
          </div>
        </div>
        <div className="hero-pipeline-band">
          <ol
            aria-label="How a Stripe event becomes an entitlement"
            className="shell hero-pipeline"
          >
            <li>
              <span className="pipeline-step">
                <span aria-hidden="true" className="pipeline-dot" />
                01 · Stripe
              </span>
              <code>checkout.session.completed</code>
              <p>Signature verified on the raw request body before any parsing.</p>
            </li>
            <li>
              <span className="pipeline-step">
                <span aria-hidden="true" className="pipeline-dot" />
                02 · Event inbox
              </span>
              <code>claimed exactly once</code>
              <p>Duplicate and out-of-order deliveries cannot double-apply.</p>
            </li>
            <li>
              <span className="pipeline-step">
                <span aria-hidden="true" className="pipeline-dot" />
                03 · PostgreSQL
              </span>
              <code>one transaction</code>
              <p>Row locks and idempotency keys apply every effect together.</p>
            </li>
            <li>
              <span className="pipeline-step">
                <span aria-hidden="true" className="pipeline-dot" />
                04 · Entitlements
              </span>
              <code>projected state</code>
              <p>Product code reads the database. The browser never grants access.</p>
            </li>
          </ol>
        </div>
      </section>

      <section aria-labelledby="capabilities-heading" className="landing-section">
        <div className="section-heading">
          <p className="eyebrow">More than a Checkout example</p>
          <h2 id="capabilities-heading">A Stripe billing template built around invariants.</h2>
          <p>
            The browser never grants access. Signed events and PostgreSQL transactions
            project the subscription, entitlement, and credit state that product code
            enforces.
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
      </section>

      <section aria-labelledby="catalog-heading" className="landing-section">
        <div className="section-heading">
          <p className="eyebrow">Bundled reference catalog</p>
          <h2 id="catalog-heading">Three tiers, monthly and annual billing.</h2>
          <p>
            Prices are explicit billing data. Stable plan rank controls upgrade and
            downgrade direction, while annual savings remain a display-only calculation.
          </p>
        </div>
        <div className="savings-grid">
          {referencePlans.map((plan) => {
            const saving = annualSavings(plan);
            const twelveMonthTotal = plan.prices.month.unit_amount * 12;
            const percent =
              saving === null ? null : Math.round((saving / twelveMonthTotal) * 100);
            return (
              <div className="savings-tile" key={plan.key}>
                <h3>{plan.name}</h3>
                <p className="savings-math">
                  <span>
                    12 ×{" "}
                    {formatMoney(
                      plan.prices.month.unit_amount,
                      plan.prices.month.currency,
                    )}{" "}
                    monthly ={" "}
                    {formatMoney(twelveMonthTotal, plan.prices.month.currency)}
                  </span>
                  <span>
                    {formatMoney(
                      plan.prices.year.unit_amount,
                      plan.prices.year.currency,
                    )}{" "}
                    billed annually
                  </span>
                </p>
                {saving === null ? (
                  <p className="savings-amount">No saving claimed</p>
                ) : (
                  <p className="savings-amount">
                    Save {formatMoney(saving, plan.prices.year.currency)}
                    <span>
                      ≈ {percent}% ·{" "}
                      {formatMoney(
                        annualEquivalentMonthly(plan),
                        plan.prices.year.currency,
                      )}
                      /mo equivalent
                    </span>
                  </p>
                )}
              </div>
            );
          })}
        </div>
        <p className="savings-footnote">
          Savings are plain catalog arithmetic rendered in the UI — no Stripe Coupon
          objects are created or claimed.
        </p>
        <p className="table-scroll-hint">Swipe horizontally to compare every column →</p>
        <div
          aria-label="Scrollable reference plan comparison"
          className="comparison-table-wrap"
          role="region"
          tabIndex={0}
        >
          <table className="comparison-table">
            <caption>Reference Stripe subscription plans and annual savings</caption>
            <thead>
              <tr>
                <th scope="col">Plan</th>
                <th scope="col">Monthly</th>
                <th scope="col">Annual total</th>
                <th scope="col">Monthly equivalent</th>
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
                    <td>{formatMoney(plan.prices.month.unit_amount, plan.prices.month.currency)}</td>
                    <td>{formatMoney(plan.prices.year.unit_amount, plan.prices.year.currency)}</td>
                    <td>
                      {formatMoney(
                        annualEquivalentMonthly(plan),
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
          This example does not claim coupons, trials, tax, multi-currency, seats, or
          metered billing. Adapt and test those policies before advertising them.
        </p>
      </section>

      <section aria-labelledby="faq-heading" className="landing-section">
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
      </section>
    </div>
  );
}
