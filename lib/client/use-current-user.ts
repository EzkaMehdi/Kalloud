"use client";

import { useEffect, useState } from "react";
import type { Role } from "@/lib/authz";
import { apiFetch } from "./api";

export interface CurrentUser {
  id: number;
  email: string;
  name: string;
  role: Role;
}

interface SessionResponse {
  authenticated: boolean;
  user?: CurrentUser;
}

/**
 * Small shared hook so every page that needs to know "am I allowed to see
 * this control" (e.g. hiding a stock-adjustment button for a CASHIER, per
 * DEC-07) does not each re-implement the same /api/auth/session fetch.
 * `undefined` means "still loading", `null` means "not authenticated"
 * (proxy.ts already redirects that case for protected pages, so this is
 * mostly relevant for the brief instant before that resolves).
 */
export function useCurrentUser(): CurrentUser | null | undefined {
  const [user, setUser] = useState<CurrentUser | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;

    function read() {
      apiFetch<SessionResponse>("/api/auth/session")
        .then((session) => {
          if (!cancelled) setUser(session.authenticated ? (session.user ?? null) : null);
        })
        .catch(() => {
          if (!cancelled) setUser(null);
        });
    }

    read();

    /**
     * Re-read when the tab comes back to the foreground.
     *
     * A session is one cookie for the whole browser, so signing in as
     * someone else in another tab silently changes who *this* tab is — and
     * a role read once at mount would keep offering the previous role's
     * controls, which the server then refuses with a 403. That is exactly
     * the "l'interface ne devrait pas proposer des actions que le serveur
     * refusera" rule the navigation applies (UX-03/SEC-05); reading only at
     * mount quietly broke it.
     *
     * Focus is the right moment: it is when the user comes back to this tab,
     * which is also the last instant before they act on what it shows.
     */
    function revalidate() {
      if (document.visibilityState === "visible") read();
    }

    window.addEventListener("focus", revalidate);
    document.addEventListener("visibilitychange", revalidate);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", revalidate);
      document.removeEventListener("visibilitychange", revalidate);
    };
  }, []);

  return user;
}
