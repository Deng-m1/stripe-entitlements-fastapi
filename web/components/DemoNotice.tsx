"use client";

import {
  publicSimulationMode,
  resetPublicSimulation,
  usesDemoConfiguration,
} from "@/lib/runtime";
import { useLocale } from "@/components/LocaleProvider";

export function DemoNotice() {
  const { t } = useLocale();
  if (!usesDemoConfiguration) return null;
  return (
    <div aria-label={t("Demo environment notice")} className="demo-notice" role="note">
      <span className="demo-status">
        <i aria-hidden="true" />
        {publicSimulationMode ? t("PUBLIC SIMULATION") : t("DEMO ONLY")}
      </span>
      <span className="demo-copy">
        {publicSimulationMode ? (
          <>
            <span>{t("Browser-local sample data only.")}</span>
            <span className="demo-scope">
              {t("No Stripe request, payment, webhook, database, or account is used.")}
            </span>
          </>
        ) : (
          <>
            <span>{t("Mock billing or browser demo authentication is active.")}</span>
            <span className="demo-scope">
              {t("Production rejects this configuration.")}
            </span>
          </>
        )}
      </span>
      {publicSimulationMode ? (
        <button
          aria-label={t("Reset simulation")}
          className="demo-reset"
          onClick={() => {
            resetPublicSimulation();
            window.location.assign("/pricing");
          }}
          type="button"
        >
          <span aria-hidden="true" className="demo-reset-icon">↺</span>
          <span className="demo-reset-label">{t("Reset simulation")}</span>
        </button>
      ) : null}
    </div>
  );
}
