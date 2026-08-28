import type { CSSProperties } from "react";

/**
 * Product bento (brief v3 §3.3, scorecard §3 P0): four real product surfaces
 * on the Stripe zh-us product-card grammar — an asymmetric bento grid where
 * every card embeds an actual reference-UI artifact composed in depth:
 * tilted front artifact (2–4° perspective), faded sibling behind, and a
 * blurred mesh-gradient glow base. Server-rendered markup; motion comes from
 * the section-level `data-reveal="group"` stagger and the two [data-depth]
 * parallax rates on the atmosphere vs. the card grid.
 *
 * The artifacts mirror the shipped screens (webhook inbox, /account
 * projection, ChangePreviewDialog, test gates) using catalog-true figures
 * (Pro $49 / 1,000 credits → Ultra $149 / 4,000 credits) so marketing never
 * invents billing behavior the reference does not implement.
 */

const stagger = (index: number): CSSProperties =>
  ({ "--stagger": index }) as CSSProperties;

const INBOX_ROWS = [
  {
    time: "16:02:09",
    event: "checkout.session.completed",
    effect: "subscription activated",
    status: "claimed" as const,
  },
  {
    time: "16:02:11",
    event: "invoice.paid",
    effect: "+1,000 credits granted",
    status: "claimed" as const,
  },
  {
    time: "16:02:11",
    event: "invoice.paid · redelivery",
    effect: "already claimed",
    status: "no-op" as const,
  },
  {
    time: "16:02:14",
    event: "charge.refunded",
    effect: "credits revoked",
    status: "claimed" as const,
  },
  {
    time: "16:02:17",
    event: "invoice.payment_failed",
    effect: "no grant",
    status: "claimed" as const,
  },
];

const PHONE_ENTITLEMENTS = [
  { key: "monthly_credits", value: "1,000" },
  { key: "concurrent_jobs", value: "5" },
  { key: "api_access", value: "granted" },
];

const GATE_RUNS = [
  { gate: "checkout · paid session", runtime: "41s" },
  { gate: "card declined", runtime: "18s" },
  { gate: "3-D Secure challenge", runtime: "47s" },
  { gate: "signed webhook", runtime: "9s" },
  { gate: "Test Clock renewal", runtime: "63s" },
  { gate: "UI projection", runtime: "22s" },
];

/* Suite wall-time sparkline: relative shape only. SVG y grows downward, so
   a descending trend (improving wall time) ends at the larger y values. */
const CHART_POINTS = [
  [0, 18],
  [24, 24],
  [48, 20],
  [72, 29],
  [96, 25],
  [120, 34],
  [144, 30],
  [168, 39],
  [192, 34],
  [216, 42],
  [240, 38],
  [264, 46],
  [288, 43],
  [312, 49],
] as const;

const chartLine = CHART_POINTS.map(([x, y], index) =>
  index === 0 ? `M${x} ${y}` : `L${x} ${y}`,
).join(" ");
const chartArea = `${chartLine} L312 72 L0 72 Z`;

export function ProductBento() {
  return (
    <div className="bento-frame">
      <div
        aria-hidden="true"
        className="bento-atmosphere parallax-layer"
        data-depth="-12"
      />
      <div className="bento-grid parallax-layer" data-depth="16">
        {/* Card 1 — the webhook inbox panel (span 7). */}
        <article
          aria-labelledby="bento-inbox-title"
          className="bento-card bento-card-inbox reveal-item"
          style={stagger(1)}
        >
          <div className="bento-card-head">
            <h3 id="bento-inbox-title">Webhook inbox</h3>
            <p>
              Every delivery is verified on the raw body, claimed once in
              PostgreSQL, and absorbed on redelivery.
            </p>
          </div>
          <div className="bento-stage">
            <div aria-hidden="true" className="bento-glow" />
            <div aria-hidden="true" className="bento-ghost" />
            <figure
              aria-label="The webhook inbox panel claiming Stripe deliveries in order"
              className="bento-artifact bento-ui-inbox"
            >
              <figcaption className="bento-ui-bar">
                <span aria-hidden="true" className="bento-ui-dots" />
                <span className="bento-ui-path">POST /stripe/webhook</span>
                <span className="bento-ui-live">
                  <span aria-hidden="true" className="bento-live-dot" />
                  live
                </span>
              </figcaption>
              <ul className="bento-inbox-rows">
                {INBOX_ROWS.map((row) => (
                  <li
                    className={row.status === "no-op" ? "is-noop" : undefined}
                    key={`${row.time}-${row.event}`}
                  >
                    <span className="bento-inbox-time">{row.time}</span>
                    <span className="bento-inbox-event">{row.event}</span>
                    <span className="bento-inbox-effect">{row.effect}</span>
                    <span
                      className={`bento-chip ${
                        row.status === "no-op" ? "chip-noop" : "chip-claimed"
                      }`}
                    >
                      {row.status}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="bento-inbox-foot">
                signature verified on the raw body · 5 deliveries · 4 applied
                · 1 absorbed
              </p>
            </figure>
          </div>
        </article>

        {/* Card 2 — the account screen projected onto a phone (span 5). */}
        <article
          aria-labelledby="bento-phone-title"
          className="bento-card bento-card-phone reveal-item"
          style={stagger(2)}
        >
          <div className="bento-card-head">
            <h3 id="bento-phone-title">Entitlement projection</h3>
            <p>
              The account screen reads what the database projected — the
              browser never decides access.
            </p>
          </div>
          <div className="bento-stage">
            <div aria-hidden="true" className="bento-glow" />
            <div aria-hidden="true" className="bento-ghost" />
            <figure
              aria-label="The account screen projecting plan entitlements on a phone"
              className="bento-artifact bento-phone"
            >
              <div className="bento-phone-screen">
                <div aria-hidden="true" className="bento-phone-status">
                  <span>9:41</span>
                  <span className="bento-phone-signal" />
                </div>
                <p className="bento-phone-kicker">Account</p>
                <div className="bento-phone-plan">
                  <span className="bento-phone-plan-name">Pro · monthly</span>
                  <span className="bento-chip chip-claimed">active</span>
                </div>
                <p className="bento-phone-figure">
                  640<span> / 1,000 credits</span>
                </p>
                <div aria-hidden="true" className="bento-phone-meter">
                  <span style={{ width: "64%" }} />
                </div>
                <ul className="bento-phone-rows">
                  {PHONE_ENTITLEMENTS.map((row) => (
                    <li key={row.key}>
                      <span>{row.key}</span>
                      <strong>{row.value}</strong>
                    </li>
                  ))}
                </ul>
                <p className="bento-phone-foot">
                  granted by invoice.paid · grant epoch 7
                </p>
              </div>
            </figure>
          </div>
        </article>

        {/* Card 3 — the prorated upgrade preview dialog (span 5). */}
        <article
          aria-labelledby="bento-preview-title"
          className="bento-card bento-card-preview reveal-item"
          style={stagger(3)}
        >
          <div className="bento-card-head">
            <h3 id="bento-preview-title">Upgrade preview</h3>
            <p>
              A paid two-line invoice settles the plan change before any
              entitlement moves.
            </p>
          </div>
          <div className="bento-stage">
            <div aria-hidden="true" className="bento-glow" />
            <div aria-hidden="true" className="bento-ghost" />
            <figure
              aria-label="The change preview dialog pricing a prorated Pro to Ultra upgrade"
              className="bento-artifact bento-preview"
            >
              <figcaption className="bento-ui-bar">
                <span className="bento-ui-path">Change preview</span>
                <span className="bento-chip chip-policy">prorated_delta</span>
              </figcaption>
              <div className="bento-preview-route">
                <span className="bento-route-pill">Pro · monthly</span>
                <span aria-hidden="true" className="bento-route-arrow">
                  →
                </span>
                <span className="bento-route-pill is-target">
                  Ultra · monthly
                </span>
              </div>
              <dl className="bento-preview-lines">
                <div>
                  <dt>Unused time on Pro</dt>
                  <dd>−$20.42</dd>
                </div>
                <div>
                  <dt>Remaining time on Ultra</dt>
                  <dd>$62.08</dd>
                </div>
                <div className="bento-preview-total">
                  <dt>Due today</dt>
                  <dd>$41.66</dd>
                </div>
              </dl>
              <p className="bento-preview-delta">
                +3,000 monthly credits · period preserved
              </p>
              <span aria-hidden="true" className="bento-preview-cta">
                Confirm upgrade
              </span>
            </figure>
          </div>
        </article>

        {/* Card 4 — the test-gate run panel with the wall-time chart (span 7). */}
        <article
          aria-labelledby="bento-gates-title"
          className="bento-card bento-card-gates reveal-item"
          style={stagger(4)}
        >
          <div className="bento-card-head">
            <h3 id="bento-gates-title">Test gates</h3>
            <p>
              Six Playwright and API gates run the advertised lifecycle
              against Stripe test mode on every change.
            </p>
          </div>
          <div className="bento-stage">
            <div aria-hidden="true" className="bento-glow" />
            <div aria-hidden="true" className="bento-ghost" />
            <figure
              aria-label="The gate run panel: six lifecycle gates and the suite wall-time trend"
              className="bento-artifact bento-gates"
            >
              <figcaption className="bento-ui-bar">
                <span aria-hidden="true" className="bento-ui-dots" />
                <span className="bento-ui-path">pytest · playwright gates</span>
                <span className="bento-chip chip-claimed">6/6 passing</span>
              </figcaption>
              <div className="bento-gates-body">
                <ul className="bento-gates-list">
                  {GATE_RUNS.map((run) => (
                    <li key={run.gate}>
                      <span aria-hidden="true" className="bento-gate-tick" />
                      <code>{run.gate}</code>
                      <span className="bento-gate-runtime">{run.runtime}</span>
                    </li>
                  ))}
                </ul>
                <div className="bento-gates-chart">
                  <svg
                    aria-hidden="true"
                    preserveAspectRatio="none"
                    viewBox="0 0 312 72"
                  >
                    <path className="bento-chart-area" d={chartArea} />
                    <path className="bento-chart-line" d={chartLine} />
                    <line
                      className="bento-chart-ref"
                      x1="0"
                      x2="312"
                      y1="54"
                      y2="54"
                    />
                  </svg>
                  <span className="bento-chart-label">
                    suite wall time · trending down
                  </span>
                </div>
              </div>
            </figure>
          </div>
        </article>
      </div>
    </div>
  );
}
