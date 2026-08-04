import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  AppError,
  isDatabaseConnectivityError,
  PayloadTooLargeError,
  ServiceUnavailableError,
  ValidationError,
} from "./errors";
import { getRequestId, logger, runWithRequestContext } from "./logger";

/**
 * Wraps every Route Handler (FND-09): generates/propagates a request id,
 * times the request, and turns any thrown error into the stable JSON
 * envelope `{ error: { code, message, requestId } }` instead of letting an
 * unhandled rejection crash the process or leak a raw stack/SQL message to
 * the client (P0-09). `context` is passed through untouched so Next's
 * dynamic-route params (`{ params: Promise<...> }` in Next.js 16) work as-is.
 */
export function apiRoute<Context>(
  handler: (request: NextRequest, context: Context) => Promise<NextResponse>,
): (request: NextRequest, context: Context) => Promise<NextResponse> {
  return async (request, context) => {
    const requestId = request.headers.get("x-request-id") ?? randomUUID();
    const route = new URL(request.url).pathname;

    return runWithRequestContext({ requestId, route, method: request.method }, async () => {
      const startedAt = Date.now();
      try {
        const response = await handler(request, context);
        response.headers.set("x-request-id", requestId);
        logger.info("request completed", {
          statusCode: response.status,
          durationMs: Date.now() - startedAt,
        });
        return response;
      } catch (error) {
        return toErrorResponse(error, requestId, Date.now() - startedAt);
      }
    });
  };
}

function toErrorResponse(error: unknown, requestId: string, durationMs: number): NextResponse {
  if (error instanceof AppError) {
    logger.warn(error.message, { code: error.code, statusCode: error.statusCode, durationMs });
    return jsonError(
      error.statusCode,
      error.code,
      error.expose ? error.message : "Une erreur est survenue.",
      requestId,
    );
  }

  if (isDatabaseConnectivityError(error)) {
    logger.error("database unreachable", {
      durationMs,
      cause: error instanceof Error ? error.message : String(error),
    });
    const unavailable = new ServiceUnavailableError();
    return jsonError(unavailable.statusCode, unavailable.code, unavailable.message, requestId);
  }

  // Unexpected error: never forward error.message to the client (it can
  // contain SQL fragments, file paths, or other internals -- P0-09). The
  // full detail is logged server-side, keyed by requestId, for diagnosis.
  logger.error("unhandled error", {
    durationMs,
    error: error instanceof Error ? (error.stack ?? error.message) : String(error),
  });
  return jsonError(500, "INTERNAL_ERROR", "Une erreur inattendue est survenue.", requestId);
}

export function jsonError(
  statusCode: number,
  code: string,
  message: string,
  requestId?: string,
): NextResponse {
  const id = requestId ?? getRequestId();
  return NextResponse.json(
    { error: { code, message, requestId: id ?? null } },
    { status: statusCode, headers: id ? { "x-request-id": id } : undefined },
  );
}

export function jsonOk<T>(data: T, init?: { status?: number }): NextResponse {
  return NextResponse.json(data, { status: init?.status ?? 200 });
}

const DEFAULT_MAX_BODY_BYTES = 100_000; // 100kB is generous for this app's JSON payloads (SEC-07 body limits).

/**
 * Reads and parses a JSON body with a size guard. Cheap Content-Length
 * pre-check plus a post-read length check; a client that omits
 * Content-Length and streams an oversized body is expected to be stopped by
 * the reverse proxy/platform limit in front of the app in production
 * (OPS-05), not solely by this in-process check.
 */
export async function readJsonBody<T = unknown>(
  request: NextRequest,
  maxBytes: number = DEFAULT_MAX_BODY_BYTES,
): Promise<T> {
  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new PayloadTooLargeError();
  }

  const text = await request.text();
  if (text.length > maxBytes) {
    throw new PayloadTooLargeError();
  }
  if (!text) {
    throw new ValidationError("Le corps de la requête est vide.");
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ValidationError("Le corps de la requête n'est pas un JSON valide.");
  }
}
