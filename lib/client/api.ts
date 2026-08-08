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
  /**
   * API-02: required by the financial endpoints. The caller must generate it
   * once per *intended* operation and reuse the same value on every retry —
   * a fresh key per attempt would defeat the whole mechanism, since the
   * server has no other way to tell a retry from a second sale.
   */
  idempotencyKey?: string;
  /**
   * SALE-08: called with the raw response headers on a successful (2xx)
   * response, before the parsed body is returned. Exists so a caller can
   * read a signal the JSON body itself does not carry — e.g. checkout's
   * `Idempotent-Replay` header (DEC-08), which distinguishes "the server
   * just ran this" from "this is the stored result of an earlier attempt,
   * handed back unchanged" — without every apiFetch caller having to deal
   * with a raw Response.
   */
  onResponseHeaders?: (headers: Headers) => void;
}

export async function apiFetch<T>(input: string, init?: ApiFetchOptions): Promise<T> {
  let response: Response;
  try {
    response = await fetch(input, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init?.idempotencyKey ? { "Idempotency-Key": init.idempotencyKey } : {}),
        ...(init?.headers ?? {}),
      },
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

  init?.onResponseHeaders?.(response.headers);
  return body as T;
}
