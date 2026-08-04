"use client";

/**
 * UX-01: the single client-side entry point for calling the API. Every page
 * that used to call `fetch("http://localhost:3001/...")` and swallow
 * failures with `.catch(() => {})` now goes through this instead (FND-08),
 * which (a) always uses a same-origin relative path, (b) redirects to
 * /login on a 401 instead of silently rendering stale/empty data, and
 * (c) throws a typed ApiError carrying the server's own message for every
 * other failure so callers can show it instead of pretending nothing
 * happened.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

interface ErrorEnvelope {
  error?: { code?: string; message?: string };
}

export interface ApiFetchOptions extends RequestInit {
  /**
   * A 401 usually means "your session is gone, go log in again". The one
   * exception is the login call itself: a wrong password is also a 401,
   * but is an expected, inline-handleable outcome, not a reason to redirect
   * a user who is, by definition, already on the login page.
   */
  suppressAuthRedirect?: boolean;
}

export async function apiFetch<T>(input: string, init?: ApiFetchOptions): Promise<T> {
  let response: Response;
  try {
    response = await fetch(input, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch {
    throw new ApiError(
      "Impossible de contacter le serveur. Vérifiez votre connexion.",
      0,
      "NETWORK_ERROR",
    );
  }

  if (response.status === 401 && !init?.suppressAuthRedirect && typeof window !== "undefined") {
    const next = encodeURIComponent(window.location.pathname);
    // A full reload (not client-side routing) is intentional: a 401 means
    // the session is gone, so every bit of client-held state is suspect —
    // this function has no access to Next's router anyway, being a plain
    // utility called from contexts that are not always components.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.href = `/login?next=${next}`;
    // The redirect above is navigating away; block callers from acting on
    // a response that will never come instead of racing the navigation.
    return new Promise<T>(() => {});
  }

  const text = await response.text();
  const body: unknown = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const envelope = body as ErrorEnvelope | null;
    throw new ApiError(
      envelope?.error?.message ?? "Une erreur est survenue.",
      response.status,
      envelope?.error?.code,
    );
  }

  return body as T;
}
