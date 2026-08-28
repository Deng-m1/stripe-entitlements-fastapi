"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { REPOSITORY_URL } from "@/lib/site";

/**
 * Sticky site header. Transparent while it rests on a page's opening
 * viewport so the hero owns the canvas, then a blurred paper bar once the
 * visitor scrolls (globals.css keys off [data-scrolled]). Server-rendered
 * markup starts in the transparent state, so no-JS visitors simply keep it.
 */
export function SiteHeader() {
  const pathname = usePathname();
  const [scrolled, setScrolled] = useState(false);

  // Re-runs on route changes too: Next.js resets the scroll position on
  // navigation without a scroll event in some engines, so the state is
  // re-read from scrollY instead of waiting for the next user scroll.
  useEffect(() => {
    const update = () => setScrolled(window.scrollY > 12);
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, [pathname]);

  return (
    <header className="site-header" data-scrolled={scrolled ? "" : undefined}>
      <div className="shell header-inner">
        <Link className="brand" href="/">
          <span aria-hidden="true" className="brand-mark" />
          <span>
            Stripe Entitlements<span className="brand-suffix"> for FastAPI</span>
          </span>
        </Link>
        <nav aria-label="Primary navigation">
          <Link
            aria-current={pathname === "/pricing" ? "page" : undefined}
            href="/pricing"
          >
            Pricing
          </Link>
          <Link
            aria-current={pathname === "/account" ? "page" : undefined}
            href="/account"
          >
            Account
          </Link>
          <a href={REPOSITORY_URL} rel="noreferrer">
            GitHub
          </a>
        </nav>
      </div>
    </header>
  );
}
