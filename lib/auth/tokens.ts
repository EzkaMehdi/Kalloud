import { createHash, randomBytes } from "node:crypto";

/** A URL-safe random token with 256 bits of entropy, suitable for session/reset-token values. */
export function generateToken(byteLength = 32): string {
  return randomBytes(byteLength).toString("base64url");
}

/**
 * Only the SHA-256 hash of a token is ever persisted (sessions, password
 * reset tokens): a database leak alone can never be replayed into a valid
 * session or reset link.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
