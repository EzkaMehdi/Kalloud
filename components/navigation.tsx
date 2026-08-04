"use client";
import Link from "next/link";
import { BarChart3, Package, ReceiptText } from "lucide-react";
import { usePathname } from "next/navigation";

const links = [
  { href: "/caisse", label: "Caisse", icon: ReceiptText },
  { href: "/stock", label: "Stock", icon: Package },
  { href: "/bilan", label: "Bilan", icon: BarChart3 },
];
export function Navigation() {
  const pathname = usePathname();
  return (
    <nav className="bottom-nav">
      <span className="nav-label">Navigation</span>
      {links.map(({ href, label, icon: Icon }) => (
        <Link className={`nav-item ${pathname === href ? "active" : ""}`} href={href} key={href}>
          <Icon size={20} />
          <span>{label}</span>
        </Link>
      ))}
    </nav>
  );
}
