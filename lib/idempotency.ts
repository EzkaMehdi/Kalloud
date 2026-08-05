import { createHash } from "node:crypto";
import { pool } from "./db";
import { ConflictError, ValidationError } from "./errors";
import { logger } from "./logger";
import type { RequestContext } from "./context";

/**
 * API-02: idempotence and concurrency control for financial operations.
 *
 * DEC-08 decided there is no offline checkout in the MVP, and spelled out
 * what must happen when a payment request is sent but the response never
 * arrives: the client retries with the same key, and "le serveur garantit
 * qu'une même clé ne produit jamais deux encaissements". This module is that
 * guarantee.
 *
 * The design hinges on one detail that is easy to get wrong: **the
 * reservation is committed outside the business transaction**. If the
 * `INSERT` that claims a key lived inside the same transaction as the sale,
 * a rollback would erase the claim, and two concurrent requests carrying the
 * same key would both proceed. Claiming the key is therefore its own
 * committed write, taken before the business work starts and released (or
 * completed) after it finishes.
 */

/** 24h: a retry is a network-timeout retry, on the scale of a service (DEC-04), not of days. */
const KEY_TTL_MS = 24 * 60 * 60 * 1000;

/** Long enough for a UUID or ULID, short enough that the column can index it. */
const KEY_PATTERN = /^[A-Za-z0-9._:-]{16,200}$/;

export interface IdempotentOutcome<T> {
  result: T;
  /** True when this response was replayed from a previously completed request. */
  replayed: boolean;
}

interface StoredKey {
  id: string;
  request_hash: string;
  status: "IN_PROGRESS" | "COMPLETED";
  response_body: unknown;
}

/**
 * Reads and validates the `Idempotency-Key` header. Required rather than
 * optional on financial endpoints: an optional guarantee is not a guarantee,
 * and a client that has not been updated to send one is precisely the client
 * whose double-click would create two sales.
 */
export function requireIdempotencyKey(request: Request): string {
  const key = request.headers.get("idempotency-key");
  if (!key) {
    throw new ValidationError(
      "En-tête Idempotency-Key manquant : cette opération financière doit être rejouable sans risque de doublon.",
    );
  }
  if (!KEY_PATTERN.test(key)) {
    throw new ValidationError(
      "En-tête Idempotency-Key invalide : 16 à 200 caractères alphanumériques, tiret, point, deux-points ou souligné.",
    );
  }
  return key;
}

/**
 * Serialises a value with object keys sorted at every depth, so that two
 * payloads that differ only in key order hash identically. Without this, a
 * legitimate retry whose JSON happened to serialise its fields in another
 * order would be rejected as "same key, different payload".
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    // Array order is meaningful (two lines of the same product are not the
    // same ticket as one line of double quantity), so it is preserved.
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
  return `{${entries.join(",")}}`;
}

export function hashPayload(payload: unknown): string {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

export interface IdempotencyOptions {
  /** Stable operation name, e.g. "POST /api/checkout". Part of the key's identity. */
  endpoint: string;
  key: string;
  /** The validated request payload. Hashed to detect a key reused with different content. */
  payload: unknown;
}

/**
 * Runs `operation` at most once per (location, endpoint, key).
 *
 * - First call: claims the key, runs the operation, stores its result.
 * - Retry after success: returns the stored result, `replayed: true`.
 * - Retry while the first call is still running: 409, so the client waits
 *   instead of racing.
 * - Same key with a different payload: 409, because returning the first
 *   result would answer a question that was not asked.
 * - Operation failed: the claim is released, so a corrected retry works.
 */
export async function withIdempotency<T>(
  context: RequestContext,
  options: IdempotencyOptions,
  operation: () => Promise<T>,
): Promise<IdempotentOutcome<T>> {
  const requestHash = hashPayload(options.payload);
  const expiresAt = new Date(Date.now() + KEY_TTL_MS);

  await purgeExpiredKeys();

  // ON CONFLICT DO NOTHING makes this both the claim and the lock: the
  // unique index decides the winner, atomically, without a read-then-write
  // race between two concurrent requests.
  const claim = await pool.query<{ id: string }>(
    `INSERT INTO idempotency_keys
       (location_id, endpoint, idempotency_key, request_hash, user_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (location_id, endpoint, idempotency_key) DO NOTHING
     RETURNING id`,
    [
      context.locationId,
      options.endpoint,
      options.key,
      requestHash,
      context.userId,
      expiresAt.toISOString(),
    ],
  );

  const claimedId = claim.rows[0]?.id;
  if (!claimedId) {
    return { result: await resolveExistingKey<T>(context, options, requestHash), replayed: true };
  }

  try {
    const result = await operation();
    await pool.query(
      `UPDATE idempotency_keys
       SET status = 'COMPLETED', response_status = $2, response_body = $3, completed_at = now()
       WHERE id = $1`,
      [claimedId, 201, JSON.stringify(result ?? null)],
    );
    return { result, replayed: false };
  } catch (error) {
    // The business transaction rolled back, so nothing was recorded and the
    // key must not stay claimed: the caller is expected to fix the request
    // (top up stock, open a business day) and retry, and DEC-08 asks that a
    // retry of a *failed* attempt be possible, not blocked for 24 hours.
    await pool
      .query("DELETE FROM idempotency_keys WHERE id = $1", [claimedId])
      .catch((cleanupError: unknown) => {
        // Losing this DELETE is not worth masking the original failure: the
        // row expires on its own, and the operator gets a log line.
        logger.error("failed to release idempotency claim", {
          idempotencyKeyId: claimedId,
          cause: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        });
      });
    throw error;
  }
}

async function resolveExistingKey<T>(
  context: RequestContext,
  options: IdempotencyOptions,
  requestHash: string,
): Promise<T> {
  const { rows } = await pool.query<StoredKey>(
    `SELECT id, request_hash, status, response_body
     FROM idempotency_keys
     WHERE location_id = $1 AND endpoint = $2 AND idempotency_key = $3`,
    [context.locationId, options.endpoint, options.key],
  );
  const stored = rows[0];

  if (!stored) {
    // The row was claimed a moment ago and has since been deleted — i.e. the
    // first attempt failed while this one was arriving. Ask the caller to
    // retry rather than silently starting a second, unclaimed operation.
    throw new ConflictError(
      "Une requête portant cette clé vient d'échouer. Réessayez avec la même clé.",
    );
  }

  if (stored.request_hash !== requestHash) {
    logger.warn("idempotency key reused with a different payload", {
      endpoint: options.endpoint,
    });
    throw new ConflictError(
      "Cette clé d'idempotence a déjà été utilisée avec une requête différente.",
    );
  }

  if (stored.status === "IN_PROGRESS") {
    throw new ConflictError(
      "Une requête identique est déjà en cours de traitement. Réessayez dans un instant.",
    );
  }

  logger.info("replaying stored idempotent response", { endpoint: options.endpoint });
  return stored.response_body as T;
}

/**
 * Expired rows are removed opportunistically on the way in rather than by a
 * scheduled job: the table only grows with financial operations, the index
 * on expires_at makes the delete cheap, and it keeps the MVP free of a cron
 * dependency it would otherwise have to deploy and monitor (OPS-05).
 */
async function purgeExpiredKeys(): Promise<void> {
  await pool.query("DELETE FROM idempotency_keys WHERE expires_at < now()");
}
