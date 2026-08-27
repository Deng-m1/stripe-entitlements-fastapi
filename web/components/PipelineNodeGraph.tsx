/**
 * M4 node graph: the webhook path as plain-language white node cards with
 * mono tech chips, thin colored connectors with dot terminals, and ONE
 * duplicate-delivery branch terminating in a "no-op (already claimed)" node.
 * Static markup + CSS; no animation (per brief §6).
 */

const NODES = [
  {
    title: "Webhook delivered — possibly twice",
    tech: "Stripe CLI",
    chip: "chip-cream",
  },
  {
    title: "Verify signature on raw body",
    tech: "FastAPI",
    chip: "chip-mint",
  },
  {
    title: "Claim event in inbox",
    tech: "PostgreSQL",
    chip: "chip-forest",
  },
  {
    title: "Apply effects in one transaction",
    tech: "PostgreSQL",
    chip: "chip-forest",
  },
  {
    title: "Project entitlements",
    tech: "FastAPI",
    chip: "chip-mint",
  },
];

const CONNECTOR_COLORS = ["c-mint", "c-forest", "c-forest", "c-mint"];

export function PipelineNodeGraph() {
  return (
    <div className="node-graph">
      {NODES.map((node, index) => (
        <div className={`node-card node-${index + 1}`} key={node.title}>
          <p className="node-title">{node.title}</p>
          <span className={`node-chip ${node.chip}`}>{node.tech}</span>
        </div>
      ))}
      {CONNECTOR_COLORS.map((color, index) => (
        <span
          aria-hidden="true"
          className={`node-connector conn-${index + 1} ${color}`}
          key={color + String(index)}
        />
      ))}
      <span aria-hidden="true" className="branch-elbow" />
      <div className="node-card node-noop">
        <p className="node-title">
          <span className="branch-label">duplicate redelivery</span>
          no-op — already claimed
        </p>
        <span className="node-chip chip-plain">PostgreSQL</span>
      </div>
    </div>
  );
}
