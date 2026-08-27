import Link from "next/link";
import { REPOSITORY_URL } from "@/lib/site";

export function SiteHeader() {
  return (
    <header className="site-header">
      <div className="shell header-inner">
        <Link className="brand" href="/">
          <span aria-hidden="true" className="brand-mark" />
          <span>
            Stripe Entitlements<span className="brand-suffix"> for FastAPI</span>
          </span>
        </Link>
        <nav aria-label="Primary navigation">
          <Link href="/pricing">Pricing</Link>
          <Link href="/account">Account</Link>
          <a href={REPOSITORY_URL} rel="noreferrer">
            GitHub
          </a>
        </nav>
      </div>
    </header>
  );
}
