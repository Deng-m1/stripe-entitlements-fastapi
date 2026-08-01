import { ImageResponse } from "next/og";

export function createSocialImage(): ImageResponse {
  return new ImageResponse(
    <div
      style={{
        alignItems: "flex-start",
        background:
          "radial-gradient(circle at 15% 0%, #dbe7ff 0, transparent 48%), #f5f7fb",
        color: "#142033",
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
          color: "#2055d6",
          display: "flex",
          fontSize: 27,
          fontWeight: 700,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
        }}
      >
        Open-source Stripe subscription billing
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
        <div
          style={{
            display: "flex",
            fontSize: 68,
            fontWeight: 800,
            letterSpacing: "-0.045em",
            lineHeight: 1.02,
            maxWidth: 1030,
          }}
        >
          Race-safe Stripe billing for FastAPI.
        </div>
        <div
          style={{
            color: "#526174",
            display: "flex",
            fontSize: 31,
            lineHeight: 1.35,
          }}
        >
          PostgreSQL entitlements · Next.js pricing · real webhook and Test Clock gates
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
              background: "#ffffff",
              border: "1px solid #cbd7e8",
              borderRadius: 999,
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
