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
    apiFetch<SessionResponse>("/api/auth/session")
      .then((session) => {
        if (!cancelled) setUser(session.authenticated ? (session.user ?? null) : null);
      })
      .catch(() => {
        if (!cancelled) setUser(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return user;
}
