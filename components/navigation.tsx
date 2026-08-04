"use client";

import { BarChart3, Package, ReceiptText } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { can, type Role } from "@/lib/authz";

const links = [
  { href: "/caisse", label: "Caisse", icon: ReceiptText, permission: "orders:create" as const },
  { href: "/stock", label: "Stock", icon: Package, permission: null },
  { href: "/bilan", label: "Bilan", icon: BarChart3, permission: "dashboard:view" as const },
];

export function Navigation({ role }: { role?: Role }) {
  const pathname = usePathname();
  // DEC-07: a CASHIER has no "dashboard:view" permission, so the link to a
  // page they would only get a 403 from is not shown at all (UX-03/SEC-05:
  // the interface should not offer actions the server will refuse).
  const visibleLinks = links.filter(
    (link) => !link.permission || !role || can(role, link.permission),
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
