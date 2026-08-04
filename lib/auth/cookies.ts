import { cookies } from "next/headers";
import type { NextResponse } from "next/server";

export const SESSION_COOKIE_NAME = "kalloud_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days (SEC-03 "expiration")

/**
 * `secure` is relaxed outside production so local HTTP dev (`pnpm dev` on
 * plain http://localhost) still works; every real deployment target is
 * HTTPS end-to-end (DEC-02), where it is always enforced.
 */
function baseCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
  };
}

export function setSessionCookie(response: NextResponse, token: string, expiresAt: Date): void {
  response.cookies.set({
    name: SESSION_COOKIE_NAME,
    value: token,
    ...baseCookieOptions(),
    expires: expiresAt,
  });
}

export function clearSessionCookie(response: NextResponse): void {
  response.cookies.set({
    name: SESSION_COOKIE_NAME,
    value: "",
    ...baseCookieOptions(),
    maxAge: 0,
  });
}

/** Reads the raw session token from the incoming request's cookies (Next.js 16 async cookies API). */
export async function readSessionToken(): Promise<string | null> {
  const store = await cookies();
  return store.get(SESSION_COOKIE_NAME)?.value ?? null;
}
