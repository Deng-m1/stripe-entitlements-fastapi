/**
 * Pipeline node graph: the webhook path as plain-language white node cards
 * with mono tech chips, thin connectors with dot terminals, and ONE
 * duplicate-delivery branch terminating in a "no-op (already claimed)" node.
 * On the landing the cards sit over the full-width violet gradient band
 * (brief v3 §3.3) and cascade in with the section's staggered group reveal:
 * card → connector → card, then the branch and its no-op terminal.
 */

import type { CSSProperties } from "react";

const stagger = (index: number): CSSProperties =>
  ({ "--stagger": index }) as CSSProperties;

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
        <div
          className={`node-card node-${index + 1} reveal-item`}
          key={node.title}
          style={stagger(index * 2)}
        >
          <p className="node-title">{node.title}</p>
          <span className={`node-chip ${node.chip}`}>{node.tech}</span>
        </div>
      ))}
      {CONNECTOR_COLORS.map((color, index) => (
        <span
          aria-hidden="true"
          className={`node-connector conn-${index + 1} ${color} reveal-item`}
          key={color + String(index)}
          style={stagger(index * 2 + 1)}
        />
      ))}
      <span
        aria-hidden="true"
        className="branch-elbow reveal-item"
        style={stagger(9)}
      />
      <div className="node-card node-noop reveal-item" style={stagger(10)}>
        <p className="node-title">
          <span className="branch-label">duplicate redelivery</span>
          no-op — already claimed
        </p>
        <span className="node-chip chip-plain">PostgreSQL</span>
      </div>
    </div>
  );
}
