import { ImageResponse } from "next/og";

/**
 * Paper-theme social card (brief §4 tokens): warm off-white canvas, ink
 * typography, ONE orange accent, and the event-pill vocabulary as the
 * bottom artifact row.
 */
export function createSocialImage(): ImageResponse {
  return new ImageResponse(
    <div
      style={{
        alignItems: "flex-start",
        background: "#faf6ef",
        backgroundImage: "radial-gradient(#d8d2c6 2px, transparent 2.5px)",
        backgroundSize: "38px 38px",
        color: "#17201c",
        display: "flex",
        flexDirection: "column",
        height: "100%",
        justifyContent: "space-between",
        padding: "70px 82px",
        width: "100%",
      }}
    >
      <div
        style={{
          color: "#6b7570",
          display: "flex",
          fontSize: 25,
          fontWeight: 700,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
        }}
      >
        Open-source Stripe billing + entitlements
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 26 }}>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            fontSize: 68,
            fontWeight: 800,
            letterSpacing: "-0.04em",
            lineHeight: 1.06,
            maxWidth: 1000,
          }}
        >
          Billing events are chaos. Your entitlements{" "}
          <span style={{ color: "#e35a1f", marginLeft: 16 }}>aren’t.</span>
        </div>
        <div
          style={{
            color: "#6b7570",
            display: "flex",
            fontSize: 30,
            lineHeight: 1.4,
            maxWidth: 980,
          }}
        >
          Subscriptions, exact fractional credits, one-time credit packs, and
          race-safe webhooks for FastAPI + PostgreSQL
        </div>
      </div>
      <div style={{ alignItems: "center", display: "flex", gap: 16 }}>
        {[
          { label: "invoice.paid", background: "#1e3a2f", color: "#dcefe2" },
          {
            label: "entitlement.granted",
            background: "#cfe8d8",
            color: "#1e3a2f",
          },
          { label: "charge.refunded", background: "#f0e2c8", color: "#8a3b2a" },
          {
            label: "dispute.created",
            background: "#ffffff",
            color: "#b3261c",
            border: "1px solid #e3ddd2",
          },
        ].map((pill) => (
          <div
            key={pill.label}
            style={{
              background: pill.background,
              border: pill.border ?? "1px solid transparent",
              borderRadius: 999,
              color: pill.color,
              display: "flex",
              fontSize: 22,
              fontWeight: 600,
              padding: "13px 24px",
            }}
          >
            {pill.label}
          </div>
        ))}
      </div>
    </div>,
    { height: 630, width: 1200 },
  );
}
