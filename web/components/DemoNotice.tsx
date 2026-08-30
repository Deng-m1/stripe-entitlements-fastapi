"use client";

import {
  publicSimulationMode,
  resetPublicSimulation,
  usesDemoConfiguration,
} from "@/lib/runtime";

export function DemoNotice() {
  if (!usesDemoConfiguration) return null;
  return (
    <div aria-label="Demo environment notice" className="demo-notice" role="note">
      <span>
        {publicSimulationMode
          ? "PUBLIC SIMULATION — browser-local sample data only. No Stripe request, payment, webhook, database, or account is used."
          : "DEMO ONLY — mock billing data or browser-exposed demo authentication is active. Production runtime rejects this configuration."}
      </span>
      {publicSimulationMode ? (
        <button
          className="demo-reset"
          onClick={() => {
            resetPublicSimulation();
            window.location.assign("/pricing");
          }}
          type="button"
        >
          Reset simulation
        </button>
      ) : null}
    </div>
  );
}
