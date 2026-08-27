/**
 * M3 centerpiece: jittered webhook deliveries on top drop through dotted SVG
 * connectors into an ordered, deduplicated `event_inbox` ledger table. The
 * newest row renders faded (Midday's arriving-row trick) and empty ruled rows
 * follow. Server-rendered markup; the section-level IntersectionObserver only
 * toggles `.is-revealed` for the one-shot line-draw + row-settle transition.
 */

interface LedgerRow {
  seq: string;
  event: string;
  effect: string;
  status: "applied" | "absorbed";
  arriving?: boolean;
}

const SOURCES = [
  { type: "invoice.paid", delivery: "#2" },
  { type: "checkout.session.completed", delivery: "#1" },
  { type: "invoice.paid", delivery: "#2 dup" },
  { type: "charge.refunded", delivery: "#3" },
];

const ROWS: LedgerRow[] = [
  {
    seq: "001",
    event: "checkout.session.completed",
    effect: "subscription activated",
    status: "applied",
  },
  {
    seq: "002",
    event: "invoice.paid",
    effect: "+500 credits granted",
    status: "applied",
  },
  {
    seq: "002",
    event: "invoice.paid · redelivery",
    effect: "no-op — already claimed",
    status: "absorbed",
  },
  {
    seq: "003",
    event: "charge.refunded",
    effect: "credits revoked",
    status: "applied",
    arriving: true,
  },
];

const CONNECTOR_XS = [50, 150, 250, 350];

export function LedgerFlow() {
  return (
    <figure
      aria-label="Out-of-order webhook deliveries settling into the ordered event_inbox ledger"
      className="ledger-card"
    >
      <figcaption className="ledger-card-label">event_inbox</figcaption>
      <div aria-hidden="true" className="ledger-sources">
        {SOURCES.map((source, index) => (
          <span
            className={`ledger-source ledger-source-${index + 1}`}
            key={`${source.type}-${source.delivery}`}
          >
            <span className="ledger-source-type">{source.type}</span>
            <span className="ledger-source-delivery">{source.delivery}</span>
          </span>
        ))}
      </div>
      <svg
        aria-hidden="true"
        className="ledger-connectors"
        preserveAspectRatio="none"
        viewBox="0 0 400 44"
      >
        {CONNECTOR_XS.map((x) => (
          <line
            className="ledger-connector"
            key={x}
            pathLength={44}
            vectorEffect="non-scaling-stroke"
            x1={x}
            x2={x}
            y1={0}
            y2={44}
          />
        ))}
      </svg>
      <table className="ledger-table">
        <caption className="sr-only">
          The event inbox ledger: ordered and deduplicated Stripe deliveries
        </caption>
        <thead>
          <tr>
            <th scope="col">Seq</th>
            <th scope="col">Event</th>
            <th scope="col">Effect</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {ROWS.map((row, index) => (
            <tr
              className={`ledger-fill-row${row.arriving ? " ledger-arriving" : ""}`}
              key={`${row.seq}-${row.event}`}
              style={{ transitionDelay: `${0.25 + index * 0.09}s` }}
            >
              <td className="ledger-seq">{row.seq}</td>
              <td className="ledger-event">{row.event}</td>
              <td>{row.effect}</td>
              <td>
                <span className={`ledger-chip chip-${row.status}`}>
                  {row.status}
                </span>
              </td>
            </tr>
          ))}
          {[0, 1, 2, 3, 4].map((empty) => (
            <tr aria-hidden="true" className="ledger-empty-row" key={empty}>
              <td colSpan={4} />
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
