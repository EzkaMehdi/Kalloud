import type { NextRequest } from "next/server";
import type { z } from "zod";
import { ValidationError, type ValidationIssue } from "../errors";
import { readJsonBody } from "../http";
import { idParamSchema } from "./primitives";

/**
 * API-01: the bridge between zod and this application's stable error
 * contract (`lib/errors.ts` / `lib/http.ts`). Route handlers never see a
 * `ZodError`; they get the same `ValidationError` → `400 VALIDATION_ERROR`
 * envelope as every other business failure, now carrying which fields were
 * rejected.
 */

/** `["items", 0, "quantity"]` → `"items[0].quantity"`, the form a client can map back to an input. */
function formatPath(path: readonly PropertyKey[]): string {
  return path.reduce<string>((accumulator, segment) => {
    if (typeof segment === "number") return `${accumulator}[${segment}]`;
    return accumulator ? `${accumulator}.${String(segment)}` : String(segment);
  }, "");
}

function toValidationError(error: z.ZodError, fallbackMessage: string): ValidationError {
  const details: ValidationIssue[] = error.issues.map((issue) => ({
    field: formatPath(issue.path),
    message: issue.message,
  }));
  // The top-level message stays a single, human, French sentence — the same
  // shape the UI already renders — while `details` carries the per-field
  // breakdown for forms that want it.
  return new ValidationError(details[0]?.message ?? fallbackMessage, { details, cause: error });
}

/** Validates an already-materialised value. Use from services and scripts, where there is no Request. */
export function parseOrThrow<Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
  fallbackMessage = "Données invalides.",
): z.output<Schema> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw toValidationError(result.error, fallbackMessage);
  }
  return result.data;
}

/**
 * Reads, size-guards and validates a JSON request body in one step. This is
 * the only way a route handler should obtain a body: `readJsonBody` alone
 * returns an unchecked `any`-shaped object, which is how unvalidated input
 * used to reach the database (enforced by tests/unit/architecture.test.ts).
 */
export async function parseJsonBody<Schema extends z.ZodType>(
  request: NextRequest,
  schema: Schema,
  options: { maxBytes?: number } = {},
): Promise<z.output<Schema>> {
  const raw = await readJsonBody<unknown>(request, options.maxBytes);
  return parseOrThrow(schema, raw, "Corps de requête invalide.");
}

/**
 * Validates a query string. Unlike bodies, query schemas are deliberately
 * not strict: proxies, link trackers and browsers append parameters of their
 * own, and refusing a request over an unread `?utm_source=` would be a bug,
 * not a safety feature.
 */
export function parseSearchParams<Schema extends z.ZodType>(
  request: NextRequest,
  schema: Schema,
): z.output<Schema> {
  const entries = Object.fromEntries(new URL(request.url).searchParams);
  return parseOrThrow(schema, entries, "Paramètres de requête invalides.");
}

/** Validates a dynamic route segment (`/api/products/[id]`) into a positive integer id. */
export function parseIdParam(value: string, label = "Identifiant"): number {
  const result = idParamSchema.safeParse(value);
  if (!result.success) {
    throw new ValidationError(`${label} invalide : "${value}".`);
  }
  return result.data;
}
