"use client";

import { usesDemoConfiguration } from "@/lib/runtime";

export function DemoNotice() {
  if (!usesDemoConfiguration) return null;
  return (
    <div aria-label="Demo environment notice" className="demo-notice" role="note">
      DEMO ONLY — mock billing data or browser-exposed demo authentication is active.
      Production runtime rejects this configuration.
    </div>
  );
}
