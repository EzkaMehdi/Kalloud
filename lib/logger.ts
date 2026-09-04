import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Structured, correlated logging (OPS-01). Every HTTP request runs inside
 * `runWithRequestContext`, which stashes a request id (and, once resolved,
 * the acting user/location) in AsyncLocalStorage. Any `logger.*` call made
 * anywhere in that request's call stack — route handler, repository,
 * service — automatically inherits those fields without threading them
 * through every function signature, so a failed checkout can be traced from
 * the browser's `X-Request-Id` response header down to the exact database
 * error without ever printing a secret.
 */
export interface RequestLogContext {
  requestId: string;
  method?: string;
  route?: string;
  userId?: number;
  locationId?: number;
  [key: string]: unknown;
}

const storage = new AsyncLocalStorage<RequestLogContext>();

export function runWithRequestContext<T>(context: RequestLogContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** Lets a handler attach fields (e.g. userId/locationId) once auth resolves. */
export function updateRequestContext(patch: Partial<RequestLogContext>): void {
  const current = storage.getStore();
  if (current) {
    Object.assign(current, patch);
  }
}

export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

export type LogFields = Record<string, unknown>;

const SENSITIVE_KEYS = new Set([
  "password",
  "passwordHash",
  "password_hash",
  "token",
  "tokenHash",
  "cookie",
]);

/**
 * OPS-08: redaction walks the whole structure, not just the top level.
 *
 * Nothing logs a nested object today — every call site passes scalars — so
 * this closes a hazard rather than a leak. But `LogFields` is
 * `Record<string, unknown>`, and the first `logger.info("…", { body })`
 * someone writes would print a password in plaintext, in the one module
 * whose stated contract is that it never does (OPS-01, DEC-10). A guard
 * that only holds while everyone remembers is not a guard.
 *
 * Depth-capped so a cyclic or pathological object cannot turn a log line
 * into a hang.
 */
const MAX_REDACT_DEPTH = 6;

function redactValue(value: unknown, depth: number): unknown {
  if (depth > MAX_REDACT_DEPTH) return "[truncated]";
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, depth + 1));
  if (value && typeof value === "object") {
    // Errors and dates carry no key/value shape worth walking, and
    // stringifying them here is what every call site already expects.
    if (value instanceof Error || value instanceof Date) return value;
    const safe: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      safe[key] = SENSITIVE_KEYS.has(key) ? "[redacted]" : redactValue(nested, depth + 1);
    }
    return safe;
  }
  return value;
}

function redact(fields: LogFields): LogFields {
  const safe: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    safe[key] = SENSITIVE_KEYS.has(key) ? "[redacted]" : redactValue(value, 1);
  }
  return safe;
}

function write(
  level: "debug" | "info" | "warn" | "error",
  message: string,
  fields: LogFields = {},
) {
  const context = storage.getStore();
  const entry = {
    time: new Date().toISOString(),
    level,
    message,
    ...context,
    ...redact(fields),
  };
  const line = JSON.stringify(entry);
  if (level === "error" || level === "warn") console.error(line);
  // eslint-disable-next-line no-console -- this module is the one sanctioned place to log at info/debug level.
  else console.log(line);
}

export const logger = {
  debug: (message: string, fields?: LogFields) => write("debug", message, fields),
  info: (message: string, fields?: LogFields) => write("info", message, fields),
  warn: (message: string, fields?: LogFields) => write("warn", message, fields),
  error: (message: string, fields?: LogFields) => write("error", message, fields),
};
