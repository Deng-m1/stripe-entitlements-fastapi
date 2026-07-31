import Link from "next/link";

export function SiteHeader() {
  return (
    <header className="site-header">
      <div className="shell header-inner">
        <Link className="brand" href="/pricing">
          Entitlements Reference
        </Link>
        <nav aria-label="Primary navigation">
          <Link href="/pricing">Pricing</Link>
          <Link href="/account">Account</Link>
        </nav>
      </div>
    </header>
  );
}
