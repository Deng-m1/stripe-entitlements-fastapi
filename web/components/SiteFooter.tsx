"use client";

import { useLocale } from "@/components/LocaleProvider";
import { SITE_NAME } from "@/lib/site";

export function SiteFooter() {
  const { t } = useLocale();

  return (
    <footer className="shell footer">
      <span className="footer-brand">{SITE_NAME}</span>
      <span>
        {t(
          "Reference UI only. Stripe and webhook state remain server-authoritative.",
        )}
      </span>
    </footer>
  );
}
