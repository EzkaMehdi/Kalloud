/**
 * Stable error contract (FND-09). Every business/validation failure a route
 * handler throws should be one of these so lib/http.ts can turn it into a
 * predictable JSON envelope instead of leaking a raw driver/stack message
 * to the client (the exact leak flagged as P0-09 in the audit).
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  /** Whether `message` is safe to send to the client as-is. */
  readonly expose: boolean;

  constructor(
    message: string,
    options: { statusCode: number; code: string; expose?: boolean; cause?: unknown },
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "AppError";
    this.statusCode = options.statusCode;
    this.code = options.code;
    this.expose = options.expose ?? true;
  }
}

/** One rejected field, so a form can highlight the input rather than a banner (UX-05). */
export interface ValidationIssue {
  field: string;
  message: string;
}

export class ValidationError extends AppError {
  /**
   * Per-field detail, populated by lib/validation/parse.ts. Optional and
   * additive: the `{ error: { code, message, requestId } }` envelope every
   * existing client reads is unchanged, `details` is simply present when the
   * server knows which fields were at fault.
   */
  readonly details?: readonly ValidationIssue[];

  constructor(
    message: string,
    options: { cause?: unknown; details?: readonly ValidationIssue[] } = {},
  ) {
    super(message, { statusCode: 400, code: "VALIDATION_ERROR", cause: options.cause });
    if (options.details?.length) {
      this.details = options.details;
    }
  }
}

export class UnauthenticatedError extends AppError {
  constructor(message = "Authentification requise.") {
    super(message, { statusCode: 401, code: "UNAUTHENTICATED" });
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Cette action n'est pas autorisée pour votre rôle.") {
    super(message, { statusCode: 403, code: "FORBIDDEN" });
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Ressource introuvable.") {
    super(message, { statusCode: 404, code: "NOT_FOUND" });
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, { statusCode: 409, code: "CONFLICT" });
  }
}

export class TooManyRequestsError extends AppError {
  constructor(message = "Trop de tentatives. Réessayez plus tard.") {
    super(message, { statusCode: 429, code: "TOO_MANY_REQUESTS" });
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(
    message = "Service temporairement indisponible. Réessayez dans un instant.",
    cause?: unknown,
  ) {
    super(message, { statusCode: 503, code: "SERVICE_UNAVAILABLE", cause });
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(message = "La requête dépasse la taille autorisée.") {
    super(message, { statusCode: 413, code: "PAYLOAD_TOO_LARGE" });
  }
}

/** Postgres/driver error codes that mean "the database is unreachable right now", not "your query is wrong". */
const CONNECTIVITY_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENOTFOUND",
  "57P03", // cannot_connect_now
  "53300", // too_many_connections
]);

export function isDatabaseConnectivityError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && CONNECTIVITY_ERROR_CODES.has(code);
}

/** Postgres unique_violation, used to turn duplicate-key errors into a clean 409 instead of a 500. */
export function isUniqueViolation(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && (error as { code?: unknown }).code === "23505",
  );
}
