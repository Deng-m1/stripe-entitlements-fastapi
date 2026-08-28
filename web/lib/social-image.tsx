import { ImageResponse } from "next/og";

/**
 * Social card, drawn from the same tokens as the site (DESIGN_SYSTEM.md §6:
 * OG imagery re-skins in the same change as the tokens). White canvas, navy
 * ink, the mesh ramp as the atmosphere in the top-right corner exactly where
 * the hero's wave sits, and the event-pill vocabulary as the artifact row.
 *
 * Satori supports neither `background-clip: text` nor `filter`, so the
 * atmosphere is built from stacked radial gradients on positioned blocks
 * rather than from a blurred canvas.
 */

const MESH_VIOLET = "#7a5af8";
const MESH_PINK = "#ff5c8f";
const MESH_ORANGE = "#ff8a3c";
const MESH_LEMON = "#ffd44d";
const INK = "#0b1e3d";
const INK_DIM = "#4f5e7b";
const IRIS = "#5b4cf5";
const HAIRLINE = "#e4e9f1";

export function createSocialImage(): ImageResponse {
  return new ImageResponse(
    <div
      style={{
        background: "#ffffff",
        color: INK,
        display: "flex",
        height: "100%",
        position: "relative",
        width: "100%",
      }}
    >
      {/* The mesh field. Three overlapping radials in ramp order reproduce the
          hero's violet → pink → orange → lemon drift without an image asset. */}
      <div
        style={{
          backgroundImage: [
            `radial-gradient(42% 80% at 80% 4%, ${MESH_VIOLET}cc, transparent 68%)`,
            `radial-gradient(38% 72% at 96% 32%, ${MESH_PINK}c4, transparent 66%)`,
            `radial-gradient(34% 62% at 80% 66%, ${MESH_ORANGE}b0, transparent 68%)`,
            `radial-gradient(30% 54% at 100% 82%, ${MESH_LEMON}a8, transparent 70%)`,
          ].join(", "),
          display: "flex",
          height: "100%",
          left: 0,
          position: "absolute",
          top: 0,
          width: "100%",
        }}
      />
      {/* Where the four ramp stops overlap at low alpha they average out to a
          grey wash. Fading white back across the copy column keeps the ink on
          the pristine canvas the system asks for and leaves the atmosphere in
          the corner the hero's wave occupies. */}
      <div
        style={{
          backgroundImage:
            "linear-gradient(96deg, #ffffff 30%, rgba(255, 255, 255, 0.72) 52%, rgba(255, 255, 255, 0) 76%)",
          display: "flex",
          height: "100%",
          left: 0,
          position: "absolute",
          top: 0,
          width: "100%",
        }}
      />
      <div
        style={{
          alignItems: "flex-start",
          display: "flex",
          flexDirection: "column",
          height: "100%",
          justifyContent: "space-between",
          padding: "70px 82px",
          position: "relative",
          width: "100%",
        }}
      >
        <div
          style={{
            alignItems: "center",
            color: INK_DIM,
            display: "flex",
            fontSize: 25,
            fontWeight: 700,
            gap: 16,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
          }}
        >
          <div
            style={{
              backgroundImage: `linear-gradient(96deg, ${MESH_VIOLET}, ${MESH_PINK} 42%, ${MESH_ORANGE} 78%, ${MESH_LEMON})`,
              borderRadius: 2,
              display: "flex",
              height: 4,
              width: 40,
            }}
          />
          Open-source Stripe subscription billing
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
              maxWidth: 860,
            }}
          >
            Billing events are chaos. Your entitlements{" "}
            <span style={{ color: IRIS, marginLeft: 16 }}>aren’t.</span>
          </div>
          <div
            style={{
              color: INK_DIM,
              display: "flex",
              fontSize: 30,
              lineHeight: 1.4,
              maxWidth: 860,
            }}
          >
            A Stripe billing reference for FastAPI, PostgreSQL, and Next.js — real
            webhook and Test Clock gates
          </div>
        </div>
        <div style={{ alignItems: "center", display: "flex", gap: 16 }}>
          {[
            { label: "invoice.paid", background: "#12234a", color: "#dbe4f5" },
            {
              label: "entitlement.granted",
              background: "#eeecfe",
              color: "#3b2fb0",
            },
            { label: "charge.refunded", background: "#fdf0dd", color: "#7a4d09" },
            {
              label: "dispute.created",
              background: "#ffffff",
              color: "#b3261c",
              border: `1px solid ${HAIRLINE}`,
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
      </div>
    </div>,
    { height: 630, width: 1200 },
  );
}
