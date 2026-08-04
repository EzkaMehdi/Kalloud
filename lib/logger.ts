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

function redact(fields: LogFields): LogFields {
  const safe: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    safe[key] = SENSITIVE_KEYS.has(key) ? "[redacted]" : value;
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
