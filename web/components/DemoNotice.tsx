"use client";

import { usesDemoConfiguration } from "@/lib/runtime";

export function DemoNotice() {
  if (!usesDemoConfiguration) return null;
  return (
    <div className="demo-notice" role="alert">
      DEMO ONLY — mock billing data or browser-exposed demo authentication is active.
      Production runtime rejects this configuration.
    </div>
  );
}
