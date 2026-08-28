import type { Metadata } from "next";
import Link from "next/link";
import type { CSSProperties } from "react";
import { HeroTerminal } from "@/components/HeroTerminal";
import { HeroWaveCanvas } from "@/components/HeroWaveCanvas";
import { LedgerFlow } from "@/components/LedgerFlow";
import { PipelineNodeGraph } from "@/components/PipelineNodeGraph";
import { ScrollParallax } from "@/components/ScrollParallax";
import { ScrollReveal } from "@/components/ScrollReveal";
import { SettlementChart } from "@/components/SettlementChart";
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

// M3 stepper: the four pipeline stages; only the active step carries body copy.
const pipelineStages = [
  {
    title: "Verify the signature on the raw body",
    body: "Every delivery is checked against the exact raw request bytes before any JSON parsing.",
  },
  {
    title: "Claim the event in the inbox",
    body: "A PostgreSQL event inbox claims one Stripe Event ID in the same transaction as its effects, so redeliveries cannot double-apply.",
  },
  {
    title: "Apply effects in one transaction",
    body: "Row locks and business idempotency keys apply every billing effect together, or not at all.",
  },
  {
    title: "Project the entitlements",
    body: "Product code reads the projected database state. The browser never grants access.",
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
    note: "SCA recovery completes before webhook-authoritative settlement",
  },
  {
    key: "webhook",
    command: "signed webhook delivery",
    note: "signature checked on the exact raw body before parsing",
  },
  {
    key: "test-clock",
    command: "Test Clock renewal",
    note: "cross-period grants advance without duplicate slots",
  },
  {
    key: "projection",
    command: "UI projection",
    note: "the account screen reads the database, never the browser",
  },
];

// M5 artifact: the dimmed gate-run ledger sitting under the light popover.
const proofLedger = [
  { date: "Feb 28", event: "checkout.session.completed", outcome: "settled" },
  { date: "Feb 27", event: "invoice.paid", outcome: "settled" },
  { date: "Feb 27", event: "invoice.paid · redelivery", outcome: "absorbed" },
  { date: "Feb 26", event: "invoice.payment_failed", outcome: "no grant" },
  { date: "Feb 25", event: "charge.refunded", outcome: "settled" },
  { date: "Feb 24", event: "test clock · renewal", outcome: "settled" },
  { date: "Feb 23", event: "dispute.created", outcome: "settled" },
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

/**
 * One eyebrow structure for every landing section (DESIGN_SYSTEM.md §2.2:
 * "Eyebrows are mono-caps and MUST precede every landing H2"). The index is
 * a separate span so the numbering carries the iris accent while the label
 * stays muted, and so a section cannot silently ship without one.
 */
function SectionEyebrow({ index, label }: { index?: string; label: string }) {
  return (
    <p className="eyebrow">
      {index ? <span className="eyebrow-index">{index}</span> : null}
      <span className="eyebrow-label">{label}</span>
    </p>
  );
}

export default function HomePage() {
  return (
    <div className="landing-page">
      <script
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(structuredData) }}
        type="application/ld+json"
      />
      <ScrollReveal />
      <ScrollParallax />

      {/* Hero — WebGL mesh-gradient wave behind the headline column
          (brief v3 §3.1), with the static poster as the SSR frame. */}
      <section aria-labelledby="hero-heading" className="paper-hero">
        <HeroWaveCanvas />
        <div className="shell">
          <div className="hero-grid">
            <div className="hero-copy">
              <SectionEyebrow label="Open-source billing reference" />
              <h1 id="hero-heading">
                <span className="h1-line">Billing events are chaos.</span>{" "}
                <span className="h1-line">
                  Your entitlements{" "}
                  <em className="hero-accent">aren&rsquo;t.</em>
                </span>
              </h1>
              <p className="hero-support">
                An open-source Stripe billing reference for FastAPI, PostgreSQL,
                and Next.js that turns noisy webhook streams into deterministic
                access.
              </p>
              <div className="hero-actions">
                <Link className="button primary" href="/pricing">
                  Explore the live demo
                </Link>
                <a className="button secondary" href={REPOSITORY_URL}>
                  View the source
                </a>
              </div>
              <ul aria-label="Core guarantees" className="hero-microcopy">
                <li>Race-safe webhooks</li>
                <li>Idempotent grants</li>
                <li>Deterministic upgrades</li>
              </ul>
            </div>
            <div className="hero-artifact">
              <HeroTerminal />
            </div>
          </div>
          <ul
            aria-label="The Stripe event vocabulary the reference settles"
            className="hero-pills"
          >
            <li className="event-pill pill-forest">invoice.paid</li>
            <li className="event-pill pill-mint">entitlement.granted</li>
            <li className="event-pill pill-cream pill-negative">
              charge.refunded
            </li>
            <li className="event-pill pill-plain pill-negative">
              dispute.created
            </li>
          </ul>
        </div>
      </section>

      {/* Sources → ledger — the centerpiece artifact. The table is a tilted
          card over a mesh shadow base with a faded sibling behind it (brief
          §3.3), and the stack scrolls at its own rate against the copy
          column so the two layers separate (§3.2). */}
      <section
        aria-labelledby="ledger-heading"
        className="paper-band"
        data-reveal="stage"
      >
        <div className="shell ledger-grid">
          <div className="ledger-intro">
            <SectionEyebrow index="01" label="How it works" />
            <h2 id="ledger-heading">
              Out-of-order events in. An ordered ledger out.
            </h2>
            <p className="section-support">
              Stripe retries, reorders, and duplicates deliveries. The
              reference binds each Event ID to its PostgreSQL effects and
              projects entitlements your product can trust.
            </p>
            <ol aria-label="The four pipeline stages" className="ledger-steps">
              {pipelineStages.map((stage, index) => (
                <li
                  className={index === 1 ? "is-active" : undefined}
                  key={stage.title}
                >
                  <span aria-hidden="true" className="step-marker" />
                  <div>
                    <h3>{stage.title}</h3>
                    {index === 1 ? <p>{stage.body}</p> : null}
                  </div>
                </li>
              ))}
            </ol>
            <SettlementChart />
          </div>
          {/* The stage holds the gradient shadow base and does not move, so
              the two card layers travel against it at distinct rates rather
              than against each other's transforms. */}
          <div className="artifact-stage">
            <span aria-hidden="true" className="artifact-ghost" data-parallax="0.03" />
            <div className="artifact-front" data-parallax="0.09">
              <LedgerFlow />
            </div>
          </div>
        </div>
      </section>

      {/* Guarantees — the node graph with its duplicate-delivery branch.
          This is the section that satisfies brief §3.3's requirement that at
          least one section layer white UI cards over a full-width gradient
          band (Stripe's dashboard-section grammar). */}
      <section aria-labelledby="invariants-heading" className="gradient-band">
        <div className="shell" data-reveal>
          <div className="section-heading">
            <SectionEyebrow index="02" label="Guarantees, not features" />
            <h2 id="invariants-heading">
              A Stripe billing reference built on invariants.
            </h2>
            <p>
              The browser never grants access. Signed events and PostgreSQL
              transactions project the subscription, entitlement, and credit
              state that product code enforces.
            </p>
            <a className="button ink" href={REPOSITORY_URL}>
              Read the code
              <span aria-hidden="true" className="button-arrow">
                →
              </span>
            </a>
          </div>
          {/* The band's own gradient is painted on the section, so giving
              the node cards a rate of their own is what separates the two
              layers as the section scrolls (brief §3.2). */}
          <div className="node-graph-layer" data-parallax="0.04">
            <PipelineNodeGraph />
          </div>
          <ol className="capability-grid">
            {capabilities.map((capability, index) => (
              <li
                data-reveal-step
                key={capability.title}
                style={{ "--reveal-step": index } as CSSProperties}
              >
                <h3>{capability.title}</h3>
                <p>{capability.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* Upgrade matrix — depth-composed card over a mesh shadow base, with
          the highlighted prorated_delta cell carrying the gradient glow. */}
      <section aria-labelledby="matrix-heading" className="paper-band band-sunken">
        <div className="shell" data-reveal>
          <div className="section-heading">
            <SectionEyebrow index="03" label="The upgrade matrix" />
            <h2 id="matrix-heading">All 36 plan transitions, defined.</h2>
            <p>
              Three plans, two intervals, no undefined cell. Every source state
              maps to every target state with an explicit outcome, so support
              never has to guess what an upgrade did to an invoice.
            </p>
          </div>
          <div className="artifact-stage">
            <div className="matrix-card" data-parallax="0.05">
              <UpgradeMatrix />
            </div>
          </div>
        </div>
      </section>

      {/* Proof band — M5: the single near-black band on the page. */}
      <section aria-labelledby="gates-heading" className="proof-band">
        <div className="shell" data-reveal>
          <div className="proof-heading">
            <SectionEyebrow index="04" label="Proof, not promises" />
            <h2 id="gates-heading">Proven against real Stripe test mode.</h2>
            <p>
              The payment lifecycle has automated gates against real Stripe
              test mode, with PostgreSQL race tests for delivery permutations.
            </p>
          </div>
          <div className="proof-grid">
            <div className="proof-artifact" data-parallax="0.05">
              <table aria-hidden="true" className="proof-table">
                <tbody>
                  {proofLedger.map((row, index) => (
                    <tr key={`${row.date}-${row.event}`}>
                      <td>{row.date}</td>
                      <td className={index === 2 ? "proof-focus" : undefined}>
                        {row.event}
                      </td>
                      <td>{row.outcome}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div aria-label="Settlement report" className="proof-popover">
                <p className="proof-popover-title">Settlement report</p>
                <dl>
                  <div>
                    <dt>race gates</dt>
                    <dd>passed</dd>
                  </div>
                  <div>
                    <dt>redeliveries</dt>
                    <dd>absorbed</dd>
                  </div>
                  <div>
                    <dt>business grants</dt>
                    <dd>deduplicated</dd>
                  </div>
                  <div>
                    <dt>entitlements</dt>
                    <dd>consistent</dd>
                  </div>
                </dl>
                <span className="ok-chip">✓ Effects remain consistent</span>
              </div>
            </div>
            <div className="proof-gates">
              <h3>Six gates run the advertised behavior end to end</h3>
              <ul className="gate-list">
                {testGates.map((gate) => (
                  <li key={gate.key}>
                    <span aria-hidden="true" className="gate-check" />
                    <div>
                      <code>{gate.command}</code>
                      <span className="gate-note">{gate.note}</span>
                    </div>
                  </li>
                ))}
              </ul>
              <a className="button outline-invert" href={REPOSITORY_URL}>
                Run the gates
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* Catalog teaser + slim SEO table — pure content (tabular SEO surface). */}
      <section aria-labelledby="catalog-heading" className="paper-band">
        <div className="shell" data-reveal>
          <div className="section-heading">
            <SectionEyebrow index="05" label="Bundled reference catalog" />
            <h2 id="catalog-heading">Three tiers, monthly and annual billing.</h2>
            <p>
              Prices are explicit billing data. Stable plan rank controls
              upgrade and downgrade direction, while annual savings remain a
              display-only calculation.
            </p>
          </div>
          <div className="catalog-tiles">
            {referencePlans.map((plan, index) => {
              const saving = annualSavings(plan);
              const credits = plan.entitlements.find(
                (item) => item.key === "monthly_credits",
              )?.value;
              return (
                <div
                  className="catalog-tile"
                  data-reveal-step
                  key={plan.key}
                  style={{ "--reveal-step": index } as CSSProperties}
                >
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

      {/* FAQ — pure content, restyled to the new system; JSON-LD kept. */}
      <section aria-labelledby="faq-heading" className="paper-band band-sunken">
        <div className="shell" data-reveal>
          <div className="section-heading">
            <SectionEyebrow index="06" label="Frequently asked questions" />
            <h2 id="faq-heading">Stripe billing template FAQ</h2>
          </div>
          <div className="faq-list">
            {frequentlyAskedQuestions.map((item, index) => (
              <details
                data-reveal-step
                key={item.question}
                style={{ "--reveal-step": index } as CSSProperties}
              >
                <summary>{item.question}</summary>
                <p>{item.answer}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* Stack strip — M6 monochrome footer strip. */}
      <section aria-label="Reference stack" className="stack-strip">
        <div className="shell stack-strip-inner">
          <ul className="stack-marks">
            <li>FastAPI</li>
            <li>PostgreSQL</li>
            <li>Stripe test mode</li>
            <li>Next.js</li>
          </ul>
          <p className="stack-note">
            <a href={REPOSITORY_URL}>View the source on GitHub</a>
            <span>Apache-2.0 · reference UI only</span>
          </p>
        </div>
      </section>
    </div>
  );
}
