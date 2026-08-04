import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE_NAME } from "@/lib/auth/cookies";
import { isRateLimited } from "@/lib/security/rate-limit";

/**
 * SEC-07 (network boundary hardening) and part of the SEC-03 auth gate,
 * run on every request in the Node.js runtime (Next.js 16 renamed
 * `middleware.ts` to `proxy.ts` and dropped the Edge runtime option for it).
 *
 * This layer only does cheap, request-shape checks: security headers,
 * same-origin enforcement on mutations, a coarse request-rate limit, a
 * request body size ceiling, and a redirect-to-login based on cookie
 * *presence*. It is not where trust decisions are made — every route still
 * resolves and validates the real session against the database via
 * lib/context.ts (SEC-04) before touching any data.
 */

const PROTECTED_PAGE_PREFIXES = ["/caisse", "/stock", "/bilan"];
const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const MAX_REQUEST_BODY_BYTES = 1_000_000; // 1MB hard ceiling; routes enforce a tighter limit for their own payloads.

function withSecurityHeaders(response: NextResponse, request: NextRequest): NextResponse {
  const scriptSrc =
    process.env.NODE_ENV === "development"
      ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
      : "script-src 'self' 'unsafe-inline'";

  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.headers.set(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      scriptSrc,
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data:",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; "),
  );
  const isHttps =
    request.nextUrl.protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
  if (isHttps) {
    response.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  }
  return response;
}

function jsonError(status: number, code: string, message: string): NextResponse {
  return NextResponse.json({ error: { code, message, requestId: null } }, { status });
}

export function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  const isApiRequest = pathname.startsWith("/api/");

  if (isApiRequest) {
    const contentLength = request.headers.get("content-length");
    if (contentLength && Number(contentLength) > MAX_REQUEST_BODY_BYTES) {
      return withSecurityHeaders(
        jsonError(413, "PAYLOAD_TOO_LARGE", "La requête dépasse la taille autorisée."),
        request,
      );
    }

    // Same-origin enforcement (SEC-07): a cross-site page can still cause
    // the browser to *send* a mutating request with credentials even
    // though SameSite=Lax already blocks that in modern browsers, so this
    // is defense in depth, not the only layer. Only reject when an Origin
    // header is present and mismatched — same-origin requests do not
    // always carry one, and non-browser API clients (health checks, curl)
    // legitimately never send it.
    if (UNSAFE_METHODS.has(request.method)) {
      const origin = request.headers.get("origin");
      // Deliberately compares against the raw Host header, not
      // request.nextUrl.origin: Next's dev server normalizes the latter to
      // "localhost" even when the client actually connected via
      // "127.0.0.1", which made this check reject legitimate same-origin
      // requests (caught by tests/e2e/auth.spec.ts).
      const host = request.headers.get("host");
      const expectedOrigin = host ? `${request.nextUrl.protocol}//${host}` : request.nextUrl.origin;
      if (origin && origin !== expectedOrigin) {
        return withSecurityHeaders(
          jsonError(403, "CROSS_ORIGIN_REQUEST", "Origine de la requête non autorisée."),
          request,
        );
      }
    }

    // Coarse rate limit ahead of the DB-backed login-attempt ledger
    // (lib/auth/rate-limit.ts), which makes the actual allow/deny decision
    // for authentication specifically.
    if (pathname.startsWith("/api/auth/")) {
      const forwardedFor = request.headers.get("x-forwarded-for");
      const ip = forwardedFor
        ? forwardedFor.split(",")[0]?.trim()
        : (request.headers.get("x-real-ip") ?? "unknown");
      const limited = isRateLimited(`auth:${ip}`, { windowMs: 60_000, max: 30 });
      if (limited) {
        return withSecurityHeaders(
          jsonError(429, "TOO_MANY_REQUESTS", "Trop de requêtes. Réessayez dans un instant."),
          request,
        );
      }
    }

    return withSecurityHeaders(NextResponse.next(), request);
  }

  const isProtectedPage = PROTECTED_PAGE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
  if (isProtectedPage && !request.cookies.get(SESSION_COOKIE_NAME)) {
    const loginUrl = new URL("/login", request.nextUrl.origin);
    loginUrl.searchParams.set("next", pathname);
    return withSecurityHeaders(NextResponse.redirect(loginUrl), request);
  }

  return withSecurityHeaders(NextResponse.next(), request);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
