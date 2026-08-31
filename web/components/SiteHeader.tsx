"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLocale } from "@/components/LocaleProvider";
import { REPOSITORY_URL } from "@/lib/site";

export function SiteHeader() {
  const pathname = usePathname();
  const { locale, setLocale, t } = useLocale();

  return (
    <header className="site-header">
      <div className="shell header-inner">
        <Link className="brand" href="/">
          <span aria-hidden="true" className="brand-mark" />
          <span>
            Stripe Entitlements
            <span className="brand-suffix"> for FastAPI + TypeScript</span>
          </span>
        </Link>
        <nav aria-label={t("Primary navigation")}>
          <Link
            aria-current={pathname === "/" ? "page" : undefined}
            className="nav-overview"
            href="/"
          >
            {t("Overview")}
          </Link>
          <Link
            aria-current={pathname === "/pricing" ? "page" : undefined}
            href="/pricing"
          >
            {t("Pricing")}
          </Link>
          <Link
            aria-current={pathname === "/account" ? "page" : undefined}
            className="nav-account"
            href="/account"
          >
            {t("Account")}
          </Link>
          <a className="header-source" href={REPOSITORY_URL} rel="noreferrer">
            <span className="source-label">{t("Source")}</span>
            <span aria-hidden="true" className="source-icon">↗</span>
          </a>
          <button
            aria-label={
              locale === "en"
                ? t("Switch language to Chinese")
                : t("Switch language to English")
            }
            className="locale-toggle"
            onClick={() => setLocale(locale === "en" ? "zh-CN" : "en")}
            type="button"
          >
            <span aria-hidden="true">{locale === "en" ? "中" : "EN"}</span>
          </button>
        </nav>
      </div>
    </header>
  );
}
