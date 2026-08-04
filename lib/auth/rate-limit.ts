import type { Queryable } from "../db";

/**
 * Brute-force protection for SEC-03/SEC-07, backed by the login_attempts
 * table rather than an in-memory counter: it survives process restarts and
 * is shared correctly even if the app ever runs as more than one instance,
 * which an in-memory map could not guarantee.
 */
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_FAILED_ATTEMPTS_PER_EMAIL = 5;
const MAX_FAILED_ATTEMPTS_PER_IP = 20;

export async function recordLoginAttempt(
  db: Queryable,
  email: string,
  ipAddress: string | null,
  succeeded: boolean,
): Promise<void> {
  await db.query("INSERT INTO login_attempts (email, ip_address, succeeded) VALUES ($1, $2, $3)", [
    email.toLowerCase(),
    ipAddress,
    succeeded,
  ]);
}

export async function isLoginRateLimited(
  db: Queryable,
  email: string,
  ipAddress: string | null,
): Promise<boolean> {
  const since = new Date(Date.now() - WINDOW_MS);
  const { rows } = await db.query<{ by_email: string; by_ip: string }>(
    `SELECT
       COUNT(*) FILTER (WHERE lower(email) = lower($1))                       AS by_email,
       COUNT(*) FILTER (WHERE $2::text IS NOT NULL AND ip_address = $2::text) AS by_ip
     FROM login_attempts
     WHERE created_at >= $3 AND succeeded = false`,
    [email, ipAddress, since],
  );
  const row = rows[0];
  if (!row) return false;
  return (
    Number(row.by_email) >= MAX_FAILED_ATTEMPTS_PER_EMAIL ||
    Number(row.by_ip) >= MAX_FAILED_ATTEMPTS_PER_IP
  );
}
