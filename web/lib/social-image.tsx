import { ImageResponse } from "next/og";

const CHAOS_DOTS = ["#2e7d5b", "#e4b65c", "#f26d5f"];

export function createSocialImage(): ImageResponse {
  return new ImageResponse(
    <div
      style={{
        alignItems: "flex-start",
        background: "#0b100e",
        color: "#ecf4ee",
        display: "flex",
        flexDirection: "column",
        height: "100%",
        justifyContent: "space-between",
        padding: "72px 82px",
        width: "100%",
      }}
    >
      <div
        style={{
          color: "#9dafa4",
          display: "flex",
          fontSize: 26,
          fontWeight: 700,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
        }}
      >
        Open-source Stripe subscription billing
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 26 }}>
        <div
          style={{
            display: "flex",
            fontSize: 66,
            fontWeight: 800,
            letterSpacing: "-0.04em",
            lineHeight: 1.04,
            maxWidth: 1000,
          }}
        >
          Billing events are chaos. Your entitlements aren’t.
        </div>
        <div
          style={{
            color: "#9dafa4",
            display: "flex",
            fontSize: 30,
            lineHeight: 1.4,
            maxWidth: 1000,
          }}
        >
          A Stripe billing reference for FastAPI, PostgreSQL, and Next.js — real
          webhook and Test Clock gates
        </div>
        <div style={{ alignItems: "center", display: "flex", gap: 14 }}>
          {CHAOS_DOTS.map((color) => (
            <div
              key={color}
              style={{
                background: color,
                borderRadius: 999,
                display: "flex",
                height: 12,
                width: 12,
              }}
            />
          ))}
          <div
            style={{
              background: "#2f4237",
              display: "flex",
              height: 40,
              margin: "0 14px",
              width: 2,
            }}
          />
          {[0, 1, 2, 3, 4, 5].map((index) => (
            <div
              key={index}
              style={{
                background: "#56e39f",
                borderRadius: 999,
                display: "flex",
                height: 12,
                width: 12,
              }}
            />
          ))}
        </div>
      </div>
      <div style={{ display: "flex", gap: 16 }}>
        {[
          "Duplicate-safe events",
          "Monthly + annual plans",
          "SCA + renewal tests",
        ].map((label) => (
          <div
            key={label}
            style={{
              background: "#18231f",
              border: "1px solid #2f4237",
              borderRadius: 999,
              color: "#ecf4ee",
              display: "flex",
              fontSize: 22,
              fontWeight: 650,
              padding: "13px 21px",
            }}
          >
            {label}
          </div>
        ))}
      </div>
    </div>,
    { height: 630, width: 1200 },
  );
}
