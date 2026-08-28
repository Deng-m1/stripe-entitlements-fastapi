"use client";

import { usesDemoConfiguration } from "@/lib/runtime";

/**
 * Build-configuration disclosure for demo deployments.
 *
 * The wording and the `note` role are load-bearing and must not soften: this
 * is what tells a visitor that the billing data on screen is not real. Only
 * its visual weight is dialled down (DESIGN_SYSTEM.md §5 chrome) — the full
 * sentence stays in the accessibility tree at every viewport, including the
 * trailing clause that small screens no longer draw.
 */
export function DemoNotice() {
  if (!usesDemoConfiguration) return null;
  return (
    <div aria-label="Demo environment notice" className="demo-notice" role="note">
      <p className="demo-notice-body">
        <span className="demo-notice-flag">DEMO ONLY</span>
        <span className="demo-notice-detail">
          mock billing data or browser-exposed demo authentication is active.
          <span className="demo-notice-tail">
            {" "}
            Production runtime rejects this configuration.
          </span>
        </span>
      </p>
    </div>
  );
}
