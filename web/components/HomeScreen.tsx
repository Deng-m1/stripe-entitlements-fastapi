"use client";

import Link from "next/link";
import { useLocale } from "@/components/LocaleProvider";
import { SettlementComparison } from "@/components/SettlementComparison";
import { UpgradeMatrix } from "@/components/UpgradeMatrix";
import {
  creditAmountFromEntitlement,
  formatCreditDecimal,
} from "@/lib/credit-amount";
import { annualSavings, formatMoney } from "@/lib/money";
import {
  referenceCreditPacks,
  referencePlans,
} from "@/lib/reference-catalog";
import {
  absoluteSiteUrl,
  publicSiteUrl,
  REPOSITORY_URL,
  serializeJsonLd,
  SITE_DESCRIPTION,
  SITE_NAME,
} from "@/lib/site";
import styles from "@/app/page.module.css";

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
    title: "Exact fractional credits and credit packs",
    body: "One million integer atoms per credit, one-time Checkout packs, expiring funding lots, source-aware consumption, cash clawbacks, and product-operation refunds without floating-point drift.",
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

const processSteps = [
  {
    number: "01",
    key: "receive",
    title: "Receive",
    body: "Verify Stripe’s signature against the exact raw request body before JSON becomes trusted input.",
  },
  {
    number: "02",
    key: "settle",
    title: "Settle",
    body: "Claim the Event ID and commit inbox, ledger, entitlement, and incident effects in one PostgreSQL transaction.",
  },
  {
    number: "03",
    key: "enforce",
    title: "Enforce",
    body: "Product code reads server-projected features, limits, and exact credit balances. The browser never grants access.",
  },
] as const;

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
    question: "Can I use the Stripe billing backend without Python?",
    answer:
      "Yes. Choose either the independent Python/FastAPI implementation or the native TypeScript/Node/Next.js implementation. Both use the same PostgreSQL schema, plan catalog, settlement policies, and accounting invariants.",
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
    question: "Does it support one-time Stripe credit packs?",
    answer:
      "Yes. Hosted Checkout payment Sessions fund independently expiring credit lots after a signed payment_intent.succeeded webhook. Packs add credits only; they never grant subscription features or higher plan limits.",
  },
  {
    question: "Can product credits be fractional?",
    answer:
      "Yes. One credit is represented as one million integer atoms from PostgreSQL through the HTTP and browser boundaries. Decimal strings are exact and binary floating point is rejected for authoritative balances.",
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

function SectionIntro({
  eyebrow,
  title,
  body,
  id,
  align = "center",
}: {
  eyebrow: string;
  title: string;
  body: string;
  id: string;
  align?: "center" | "left";
}) {
  const { t } = useLocale();
  return (
    <div className={`${styles.sectionIntro} ${styles[align]}`}>
      <p className={styles.eyebrow}>{t(eyebrow)}</p>
      <h2 id={id}>{t(title)}</h2>
      <p>{t(body)}</p>
    </div>
  );
}

function WebhookMiniature() {
  return (
    <div aria-hidden="true" className={styles.webhookMiniature}>
      <div className={styles.webhookStream}>
        <span><i />invoice.paid <small>evt_19a</small></span>
        <span className={styles.duplicateEvent}><i />invoice.paid <small>duplicate</small></span>
        <span><i />charge.refunded <small>evt_81f</small></span>
      </div>
      <div className={styles.streamRail}>
        <i />
        <i />
        <i />
      </div>
      <div className={styles.inboxMini}>
        <span>event_inbox</span>
        <strong>1 claimed</strong>
        <small>1 duplicate absorbed</small>
      </div>
    </div>
  );
}

function CreditMiniature() {
  return (
    <div aria-hidden="true" className={styles.creditMiniature}>
      <div className={styles.terminalChrome}>
        <span><i /><i /><i /></span>
        atoms.ts
      </div>
      <code><span>const</span> SCALE = <strong>1_000_000n</strong></code>
      <code><span>credit</span> <i>0.125000</i> → <strong>125000</strong></code>
      <div className={styles.atomEquation}>
        <span>100.125000</span>
        <i>× 1,000,000</i>
        <strong>100125000 atoms</strong>
      </div>
    </div>
  );
}

function UpgradeMiniature() {
  return (
    <div aria-hidden="true" className={styles.upgradeMiniature}>
      <div className={styles.upgradeNode}>
        <small>SOURCE</small>
        <strong>Starter</strong>
        <span>monthly · 300 credits</span>
      </div>
      <div className={styles.upgradeRoute}>
        <span>paid 2-line Invoice</span>
        <i />
        <strong>+700</strong>
      </div>
      <div className={`${styles.upgradeNode} ${styles.targetNode}`}>
        <small>TARGET</small>
        <strong>Pro</strong>
        <span>period preserved</span>
      </div>
    </div>
  );
}

function RuntimeMiniature() {
  return (
    <div aria-hidden="true" className={styles.runtimeMiniature}>
      <div className={styles.runtimeCard}>
        <span>PY</span>
        <div><strong>FastAPI</strong><small>native runtime</small></div>
      </div>
      <div className={styles.runtimeCard}>
        <span>TS</span>
        <div><strong>Next.js / Node</strong><small>native runtime</small></div>
      </div>
      <div className={styles.runtimeDatabase}>
        <span className={styles.databaseGlyph} />
        <strong>one schema</strong>
        <small>shared golden vectors</small>
      </div>
    </div>
  );
}

function ProcessArtwork({ step }: { step: (typeof processSteps)[number]["key"] }) {
  if (step === "receive") {
    return (
      <div aria-hidden="true" className={styles.receiveArt}>
        <span>POST /webhooks/stripe</span>
        <code>stripe-signature: t=…</code>
        <div><i /> raw_body <strong>verified</strong></div>
      </div>
    );
  }
  if (step === "settle") {
    return (
      <div aria-hidden="true" className={styles.settleArt}>
        <span>BEGIN</span>
        <div><i /> claim event</div>
        <div><i /> lock account</div>
        <div><i /> apply ledger</div>
        <strong>COMMIT</strong>
      </div>
    );
  }
  return (
    <div aria-hidden="true" className={styles.enforceArt}>
      <div><span>plan</span><strong>Pro</strong></div>
      <div><span>credits</span><strong>750.000000</strong></div>
      <p><i /> access allowed</p>
    </div>
  );
}

export function HomeScreen() {
  const { numberLocale, t } = useLocale();

  return (
    <div className={`landing-page stripe-landing ${styles.root}`}>
      <script
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(structuredData) }}
        type="application/ld+json"
      />
      <section aria-labelledby="hero-heading" className={styles.hero}>
        <div aria-hidden="true" className={styles.heroGrid} />
        <div aria-hidden="true" className={styles.heroGlow} />
        <div className={styles.container}>
          <div className={styles.heroCopy}>
            <p className={styles.heroBadge}>
              <span /> {t("Open-source billing reference")} <i>v0.4.0</i>
            </p>
            <h1 id="hero-heading">
              <span>{t("Billing events are chaos.")}</span>
              <span className={styles.headlineSecond}>
                <span className={styles.selectedPhrase}>
                  {t("Your entitlements aren’t.")}
                  <i aria-hidden="true" className={styles.selectBox}>
                    <span className={styles.handleNw} />
                    <span className={styles.handleNe} />
                    <span className={styles.handleSw} />
                    <span className={styles.handleSe} />
                    <small>{t("PROJECTED STATE")}</small>
                  </i>
                </span>
              </span>
            </h1>
            <p className={styles.heroSupport}>
              {t("An open-source Stripe billing reference with native FastAPI and TypeScript/Next.js backends over PostgreSQL, turning subscriptions, exact fractional credits, and one-time credit packs into deterministic access.")}
            </p>
            <div className={styles.heroActions}>
              <Link className={`${styles.button} ${styles.primaryButton}`} href="/pricing">
                {t("Explore the live demo")}
                <span aria-hidden="true">↗</span>
              </Link>
              <a className={`${styles.button} ${styles.secondaryButton}`} href={REPOSITORY_URL}>
                {t("View the source")}
                <span aria-hidden="true">→</span>
              </a>
            </div>
            <p className={styles.heroNote}>
              <span>✓ Apache-2.0</span>
              <span>✓ {t("two native backends")}</span>
              <span>✓ {t("bounded billing policy")}</span>
            </p>
          </div>

          <div className={styles.heroCanvas}>
            <SettlementComparison />
          </div>

          <ul aria-label={t("Reference stack")} className={styles.stackRail}>
            <li><span className={styles.stackPy}>PY</span>FastAPI</li>
            <li><span className={styles.stackTs}>TS</span>TypeScript / Node</li>
            <li><span className={styles.stackPg}>PG</span>PostgreSQL 17</li>
            <li><span className={styles.stackStripe}>S</span>{t("Stripe test mode")}</li>
            <li><span className={styles.stackNext}>N</span>Next.js</li>
          </ul>
        </div>
      </section>

      <section aria-labelledby="invariants-heading" className={styles.section}>
        <div className={styles.container}>
          <SectionIntro
            body="The reference makes the hard parts visible: event identity, exact arithmetic, explicit transition policy, and two runtimes that converge on the same database contract."
            eyebrow="The invariants"
            id="invariants-heading"
            title="A Stripe billing reference built on invariants."
          />
          <div className={styles.bentoGrid}>
            <article className={`${styles.bentoCard} ${styles.bentoWide}`}>
              <WebhookMiniature />
              <div className={styles.bentoCopy}>
                <p className={styles.cardIndex}>01 / DELIVERY</p>
                <h3>{t(capabilities[0].title)}</h3>
                <p>{t(capabilities[0].body)}</p>
              </div>
            </article>
            <article className={`${styles.bentoCard} ${styles.bentoNarrow} ${styles.darkCard}`}>
              <CreditMiniature />
              <div className={styles.bentoCopy}>
                <p className={styles.cardIndex}>02 / PRECISION</p>
                <h3>{t(capabilities[2].title)}</h3>
                <p>{t(capabilities[2].body)}</p>
              </div>
            </article>
            <article className={`${styles.bentoCard} ${styles.bentoWide} ${styles.brandCard}`}>
              <UpgradeMiniature />
              <div className={styles.bentoCopy}>
                <p className={styles.cardIndex}>03 / POLICY</p>
                <h3>{t(capabilities[3].title)}</h3>
                <p>{t(capabilities[3].body)}</p>
              </div>
            </article>
            <article className={`${styles.bentoCard} ${styles.bentoNarrow}`}>
              <RuntimeMiniature />
              <div className={styles.bentoCopy}>
                <p className={styles.cardIndex}>04 / PARITY</p>
                <h3>{t("Native FastAPI and TypeScript parity")}</h3>
                <p>
                  {t("Independent runtimes share the PostgreSQL schema, plan catalog, settlement policy, and exact-credit golden vectors.")}
                </p>
              </div>
            </article>
          </div>
        </div>
      </section>

      <section aria-labelledby="ledger-heading" className={`${styles.section} ${styles.softSection}`}>
        <div className={styles.container}>
          <SectionIntro
            body="Three boundaries turn a noisy provider stream into product state. Each boundary has one job, one authority, and a failure mode that stays inspectable."
            eyebrow="Receive · settle · enforce"
            id="ledger-heading"
            title="Out-of-order events in. An ordered ledger out."
          />
          <ol className={styles.processGrid}>
            {processSteps.map((step) => (
              <li key={step.number}>
                <div className={styles.processNumber}>{step.number}</div>
                <ProcessArtwork step={step.key} />
                <h3>{t(step.title)}</h3>
                <p>{t(step.body)}</p>
              </li>
            ))}
          </ol>

          <div className={styles.ledgerWorkbench}>
            <div className={styles.workbenchChrome}>
              <span className={styles.chromeDots}><i /><i /><i /></span>
              <code>transaction / evt_9f2k</code>
              <span className={styles.transactionStatus}>COMMITTED</span>
            </div>
            <div className={styles.workbenchBody}>
              <div className={styles.transactionLog}>
                <p><span>00:00.000</span><code>BEGIN</code><i>account lock acquired</i></p>
                <p><span>00:00.004</span><code>INSERT event_inbox</code><i>evt_9f2k claimed</i></p>
                <p><span>00:00.011</span><code>INSERT credit_ledger</code><i>+1,000.000000</i></p>
                <p><span>00:00.014</span><code>UPDATE billing_accounts</code><i>plan=pro</i></p>
                <p><span>00:00.016</span><code>COMMIT</code><i>4 effects atomic</i></p>
                <p className={styles.absorbedLog}><span>00:01.288</span><code>REDELIVERY</code><i>absorbed by Event ID</i></p>
              </div>
              <aside className={styles.stateCard}>
                <div className={styles.stateCardHeader}>
                  <span>server projection</span>
                  <i>active</i>
                </div>
                <dl>
                  <div><dt>plan</dt><dd>Pro Monthly</dd></div>
                  <div><dt>credits</dt><dd>1,000.000000</dd></div>
                  <div><dt>grant epoch</dt><dd>14</dd></div>
                  <div><dt>enforceable</dt><dd className={styles.allowed}>true</dd></div>
                </dl>
                <p><span>✓</span> {t("Browser reads this state; it cannot mint it.")}</p>
              </aside>
            </div>
          </div>
        </div>
      </section>

      <section aria-labelledby="matrix-heading" className={styles.section}>
        <div className={styles.container}>
          <SectionIntro
            align="left"
            body="Three plans, two intervals, no undefined cell. Every source state maps to every target state with an explicit outcome, so billing behavior never depends on a support guess."
            eyebrow="The upgrade matrix"
            id="matrix-heading"
            title="All 36 plan transitions, defined."
          />
          <div className={styles.matrixFrame}>
            <UpgradeMatrix />
          </div>
        </div>
      </section>

      <section aria-labelledby="gates-heading" className={styles.proofSection}>
        <div aria-hidden="true" className={styles.proofGlow} />
        <div className={styles.container}>
          <div className={styles.proofHeading}>
            <p className={styles.eyebrow}>{t("Proof, not promises")}</p>
            <h2 id="gates-heading">{t("Proven against real Stripe test mode.")}</h2>
            <p>
              {t("The payment lifecycle has automated gates against real Stripe test mode, with PostgreSQL race tests for delivery permutations.")}
            </p>
          </div>
          <div className={styles.proofGrid}>
            <div className={styles.proofArtifact}>
              <div className={styles.proofArtifactChrome}>
                <span className={styles.chromeDots}><i /><i /><i /></span>
                <code>gate-run / settlement.log</code>
                <span>TEST MODE</span>
              </div>
              <table aria-hidden="true" className={styles.proofTable}>
                <tbody>
                  {proofLedger.map((row, index) => (
                    <tr key={`${row.date}-${row.event}`}>
                      <td>{row.date}</td>
                      <td className={index === 2 ? styles.proofFocus : undefined}>
                        {row.event}
                      </td>
                      <td>{row.outcome}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div aria-label="Settlement report" className={styles.proofReport}>
                <div className={styles.reportTopline}>
                  <span>Settlement report</span>
                  <i>all green</i>
                </div>
                <dl>
                  <div><dt>race gates</dt><dd>passed</dd></div>
                  <div><dt>redeliveries</dt><dd>absorbed</dd></div>
                  <div><dt>business grants</dt><dd>deduplicated</dd></div>
                  <div><dt>entitlements</dt><dd>consistent</dd></div>
                </dl>
                <p><span>✓</span> Effects remain consistent</p>
              </div>
            </div>
            <div className={styles.proofGates}>
              <p className={styles.proofKicker}>{t("AUTOMATED EVIDENCE")}</p>
              <h3>{t(capabilities[4].title)}</h3>
              <ul>
                {testGates.map((gate) => (
                  <li key={gate.key}>
                    <span className={styles.gateCheck}>✓</span>
                    <div>
                      <code>{t(gate.command)}</code>
                      <span>{t(gate.note)}</span>
                    </div>
                  </li>
                ))}
              </ul>
              <a className={`${styles.button} ${styles.proofButton}`} href={REPOSITORY_URL}>
                {t("Inspect the test gates")} <span aria-hidden="true">→</span>
              </a>
              <p className={styles.evidenceNote}>
                {t("Test-mode evidence is explicit. It is not presented as live-production payload evidence.")}
              </p>
            </div>
          </div>
        </div>
      </section>

      <section aria-labelledby="catalog-heading" className={styles.section}>
        <div className={styles.container}>
          <SectionIntro
            body="Prices are explicit billing data. Stable plan rank controls upgrade direction, while annual savings remain a display-only calculation."
            eyebrow="Bundled reference catalog"
            id="catalog-heading"
            title="Three tiers, monthly and annual billing."
          />
          <div className={styles.catalogGrid}>
            {referencePlans.map((plan) => {
              const saving = annualSavings(plan);
              const credits = plan.entitlements.find(
                (item) => item.key === "monthly_credits",
              );
              const featured = plan.key === "pro";
              return (
                <article
                  className={`${styles.catalogCard} ${featured ? styles.featuredPlan : ""}`}
                  key={plan.key}
                >
                  <div className={styles.planTopline}>
                    <h3>{plan.name}</h3>
                    {featured ? <span>{t("REFERENCE")}</span> : null}
                  </div>
                  <p className={styles.catalogPrice}>
                    {formatMoney(
                      plan.prices.month.unit_amount,
                      plan.prices.month.currency,
                      numberLocale,
                    )}
                    <span>{t("/ month")}</span>
                  </p>
                  <p className={styles.catalogCredits}>
                    <strong>
                      {credits
                        ? formatCreditDecimal(
                            creditAmountFromEntitlement(credits).decimal,
                          )
                        : "—"}
                    </strong>
                    {t("credits per monthly grant")}
                  </p>
                  <p className={styles.catalogSaving}>
                    {saving === null
                      ? t("No annual saving claimed")
                      : t("Save {{amount}} on annual billing", {
                          amount: formatMoney(
                            saving,
                            plan.prices.year.currency,
                            numberLocale,
                          ),
                        })}
                  </p>
                  <Link href="/pricing">{t("Explore {{name}}", { name: plan.name })} <span>→</span></Link>
                </article>
              );
            })}
          </div>
          <div
            aria-label={t("Scrollable reference plan comparison")}
            className={styles.tableFrame}
            role="region"
            tabIndex={0}
          >
            <table className={styles.comparisonTable}>
              <caption>{t("Reference Stripe subscription plans and annual savings")}</caption>
              <thead>
                <tr>
                  <th scope="col">{t("Plan")}</th>
                  <th scope="col">{t("Monthly")}</th>
                  <th scope="col">{t("Annual total")}</th>
                  <th scope="col">{t("Annual saving")}</th>
                  <th scope="col">{t("Monthly credits")}</th>
                </tr>
              </thead>
              <tbody>
                {referencePlans.map((plan) => {
                  const savings = annualSavings(plan);
                  const monthlyCredits = plan.entitlements.find(
                    (item) => item.key === "monthly_credits",
                  );
                  return (
                    <tr key={plan.key}>
                      <th scope="row">{plan.name}</th>
                      <td>{formatMoney(
                        plan.prices.month.unit_amount,
                        plan.prices.month.currency,
                        numberLocale,
                      )}</td>
                      <td>{formatMoney(
                        plan.prices.year.unit_amount,
                        plan.prices.year.currency,
                        numberLocale,
                      )}</td>
                      <td>
                        {savings === null
                          ? t("No saving claimed")
                          : formatMoney(
                              savings,
                              plan.prices.year.currency,
                              numberLocale,
                            )}
                      </td>
                      <td>
                        {monthlyCredits
                          ? formatCreditDecimal(
                              creditAmountFromEntitlement(monthlyCredits).decimal,
                            )
                          : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className={styles.packHeading}>
            <div>
              <p className={styles.eyebrow}>{t("One-time funding")}</p>
              <h3>{t("Stripe credit packs with exact source attribution.")}</h3>
            </div>
            <p>
              {t("Each payment creates its own expiring funding lot. Product usage records the exact subscription or pack source, so cash refunds, disputes, and Job refunds converge without floating-point drift.")}
            </p>
          </div>
          <div
            aria-label={t("Scrollable one-time credit pack comparison")}
            className={styles.tableFrame}
            role="region"
            tabIndex={0}
          >
            <table className={styles.comparisonTable}>
              <caption>{t("Reference one-time Stripe credit packs")}</caption>
              <thead>
                <tr>
                  <th scope="col">{t("Credit pack")}</th>
                  <th scope="col">{t("Exact credits")}</th>
                  <th scope="col">{t("One-time price")}</th>
                  <th scope="col">{t("Expiry after payment")}</th>
                </tr>
              </thead>
              <tbody>
                {referenceCreditPacks.map((pack) => (
                  <tr key={pack.key}>
                    <th scope="row">{pack.name}</th>
                    <td>{formatCreditDecimal(pack.credits)}</td>
                    <td>{formatMoney(
                      pack.price.unit_amount,
                      pack.price.currency,
                      numberLocale,
                    )}</td>
                    <td>{t("{{days}} days", { days: pack.expires_days })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className={styles.truthNote}>
            <span>{t("Scope boundary")}</span>
            {t("This example does not claim coupons, trials, tax, multi-currency, seats, or metered billing. Adapt and test those policies before advertising them.")}
          </p>
        </div>
      </section>

      <section aria-labelledby="faq-heading" className={`${styles.section} ${styles.faqSection}`}>
        <div className={styles.container}>
          <SectionIntro
            body="The implementation is deliberately explicit about what it proves, what it supports, and where your product still owns policy."
            eyebrow="Frequently asked questions"
            id="faq-heading"
            title="Stripe billing template FAQ"
          />
          <div className={styles.faqList}>
            {frequentlyAskedQuestions.map((item, index) => (
              <details key={item.question} open={index === 0 || undefined}>
                <summary>
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  {t(item.question)}
                  <i aria-hidden="true" />
                </summary>
                <p>{t(item.answer)}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <section aria-label={t("Project call to action")} className={styles.finalCta}>
        <div aria-hidden="true" className={styles.ctaGrid} />
        <div className={styles.container}>
          <p className={styles.eyebrow}>{t("Ship the invariant, not the demo")}</p>
          <h2>{t("Start from a billing system that shows its work.")}</h2>
          <p>
            {t("Read the invariants, run the gates, then adapt the bounded policy to your product instead of hiding billing decisions in webhook branches.")}
          </p>
          <div className={styles.heroActions}>
            <a className={`${styles.button} ${styles.primaryButton}`} href={REPOSITORY_URL}>
              {t("View on GitHub")} <span aria-hidden="true">↗</span>
            </a>
            <Link className={`${styles.button} ${styles.secondaryButton}`} href="/pricing">
              {t("Open the reference UI")} <span aria-hidden="true">→</span>
            </Link>
          </div>
          <ul className={styles.footerStack}>
            <li>FastAPI</li>
            <li>TypeScript / Node</li>
            <li>PostgreSQL</li>
            <li>{t("Stripe test mode")}</li>
            <li>Next.js</li>
          </ul>
        </div>
      </section>
    </div>
  );
}
