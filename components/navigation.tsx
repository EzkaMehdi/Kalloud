"use client";

import { BarChart3, Package, ReceiptText, Settings } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { can, type Role } from "@/lib/authz";

const links = [
  { href: "/caisse", label: "Caisse", icon: ReceiptText, permission: "orders:create" as const },
  { href: "/stock", label: "Stock", icon: Package, permission: null },
  { href: "/bilan", label: "Bilan", icon: BarChart3, permission: "dashboard:view" as const },
  // CFG-01..03: gated on `tables:manage` rather than `settings:manage` —
  // a manager administers the catalogue and the floor plan, and the screen
  // itself makes the owner-only settings read-only for them.
  {
    href: "/configuration",
    label: "Réglages",
    icon: Settings,
    permission: "tables:manage" as const,
  },
];

export function Navigation({ role }: { role?: Role }) {
  const pathname = usePathname();
  // DEC-07: a CASHIER has no "dashboard:view" permission, so the link to a
  // page they would only get a 403 from is not shown at all (UX-03/SEC-05:
  // the interface should not offer actions the server will refuse).
  //
  // While the session is still resolving, `role` is undefined — and this
  // used to fall through to "show everything", so a cashier's menu briefly
  // offered Bilan and Réglages before they disappeared. Caught as a flaky
  // assertion in tests/e2e/parcours-par-role.spec.ts, which is exactly the
  // shape of the bug: sometimes the user sees it, sometimes they do not.
  // Not knowing the role is not a reason to offer more; a link that is
  // about to vanish is one someone can click.
  const visibleLinks = links.filter(
    (link) => !link.permission || (role !== undefined && can(role, link.permission)),
  );

  return (
    <nav className="bottom-nav" aria-label="Navigation principale">
      <span className="nav-label">Navigation</span>
      {visibleLinks.map(({ href, label, icon: Icon }) => {
        const isActive = pathname === href;
        return (
          <Link
            className={`nav-item ${isActive ? "active" : ""}`}
            href={href}
            key={href}
            aria-current={isActive ? "page" : undefined}
          >
            <Icon size={20} aria-hidden="true" />
            <span>{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
