/**
 * M2 hero artifact: the single dark object on the paper hero. A pre-scripted
 * `stripe trigger` transcript revealed line by line with pure CSS
 * (`@keyframes` + per-line `animation-delay`). No rAF, no client JS;
 * `prefers-reduced-motion: reduce` renders every line statically via the
 * global animation kill-switch in globals.css.
 */
export function HeroTerminal() {
  return (
    <figure
      aria-label="Stripe CLI transcript: duplicate and out-of-order webhook deliveries settling exactly once"
      className="hero-terminal"
    >
      <figcaption className="terminal-chrome">
        <span aria-hidden="true" className="terminal-dots">
          <span />
          <span />
          <span />
        </span>
        <span className="terminal-title">
          stripe listen --forward-to /webhooks/stripe
        </span>
      </figcaption>
      <pre className="terminal-body">
        <code>
          <span className="terminal-line">
            <span className="t-prompt">$</span> stripe trigger
            invoice.payment_succeeded
          </span>
          <span className="terminal-line">
            <span className="t-dim">→ evt_9f2k…</span>{" "}
            <span className="t-type">invoice.paid</span>
            <span className="t-dim"> · delivery #2 · out of order</span>
          </span>
          <span className="terminal-line">
            <span className="t-dim">→ evt_9f2k…</span>{" "}
            <span className="t-type">invoice.paid</span>
            <span className="t-dim"> · duplicate delivery</span>
          </span>
          <span className="terminal-line">
            <span className="t-dim">→ evt_7aa1…</span>{" "}
            <span className="t-type">checkout.session.completed</span>
            <span className="t-dim"> · delivery #1 · late</span>
          </span>
          <span className="terminal-line">
            <span className="t-label">sig </span> verified on the raw request
            body
          </span>
          <span className="terminal-line">
            <span className="t-label">inbox</span> evt_9f2k… claimed once
            <span className="t-dim"> · duplicate absorbed</span>
          </span>
          <span className="terminal-line">
            <span className="t-label">txn </span> BEGIN · +500 credits ·
            idempotency key · COMMIT
          </span>
          <span className="terminal-line t-ok">
            entitlements projected · deterministic
          </span>
        </code>
      </pre>
    </figure>
  );
}
