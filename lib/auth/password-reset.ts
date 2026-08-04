import type { Queryable } from "../db";
import { generateToken, hashToken } from "./tokens";

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

export interface CreatedResetToken {
  token: string;
  expiresAt: Date;
}

export async function createPasswordResetToken(
  db: Queryable,
  userId: number,
): Promise<CreatedResetToken> {
  const token = generateToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);
  await db.query(
    "INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)",
    [userId, tokenHash, expiresAt],
  );
  return { token, expiresAt };
}

export interface ValidResetToken {
  id: number;
  userId: number;
}

export async function findValidPasswordResetToken(
  db: Queryable,
  rawToken: string,
): Promise<ValidResetToken | null> {
  const tokenHash = hashToken(rawToken);
  const { rows } = await db.query<{ id: number; user_id: number }>(
    `SELECT id, user_id FROM password_reset_tokens
     WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
    [tokenHash],
  );
  const row = rows[0];
  return row ? { id: row.id, userId: row.user_id } : null;
}

export async function markPasswordResetTokenUsed(db: Queryable, id: number): Promise<void> {
  await db.query("UPDATE password_reset_tokens SET used_at = now() WHERE id = $1", [id]);
}
