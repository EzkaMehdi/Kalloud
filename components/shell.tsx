"use client";

import { Coffee, LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { apiFetch } from "@/lib/client/api";
import { useCurrentUser } from "@/lib/client/use-current-user";
import { ROLE_LABELS } from "@/lib/authz";
import { Navigation } from "./navigation";

function initialsFor(name: string): string {
  return name
    .split(" ")
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

export function Shell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const user = useCurrentUser();

  async function handleLogout() {
    try {
      await apiFetch("/api/auth/logout", { method: "POST" });
    } finally {
      router.push("/login");
      router.refresh();
    }
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">
            <Coffee size={18} />
          </span>
          Kalloud
        </div>
        {user && (
          <div className="user-menu">
            <div className="user-menu-info">
              <strong>{user.name}</strong>
              <small>{ROLE_LABELS[user.role]}</small>
            </div>
            <span className="avatar" aria-hidden="true">
              {initialsFor(user.name)}
            </span>
            <button
              type="button"
              className="icon-button"
              onClick={handleLogout}
              aria-label="Se déconnecter"
            >
              <LogOut size={18} />
            </button>
          </div>
        )}
      </header>
      {/* UX-03: skip-link target from app/layout.tsx; tabIndex makes it a real focus stop, not just a scroll anchor. */}
      <div id="main-content" tabIndex={-1}>
        {children}
      </div>
      <Navigation role={user?.role} />
    </main>
  );
}
