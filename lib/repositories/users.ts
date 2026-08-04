import type { Queryable } from "../db";

export interface UserRecord {
  id: number;
  email: string;
  passwordHash: string;
  name: string;
  status: "ACTIVE" | "DISABLED";
}

interface UserRow {
  id: number;
  email: string;
  password_hash: string;
  name: string;
  status: "ACTIVE" | "DISABLED";
}

function mapUser(row: UserRow): UserRecord {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    name: row.name,
    status: row.status,
  };
}

/**
 * Deliberately not location-scoped: authentication happens before a
 * location is known (the membership lookup that resolves it comes right
 * after, in lib/auth/session.ts). Every other repository in this directory
 * takes locationId as its first argument (SEC-06); this is the one
 * necessary exception, and it is never used to serve business data.
 */
export async function findUserByEmail(db: Queryable, email: string): Promise<UserRecord | null> {
  const { rows } = await db.query<UserRow>(
    "SELECT id, email, password_hash, name, status FROM users WHERE lower(email) = lower($1)",
    [email],
  );
  const row = rows[0];
  return row ? mapUser(row) : null;
}

export async function updateUserPassword(
  db: Queryable,
  userId: number,
  passwordHash: string,
): Promise<void> {
  await db.query("UPDATE users SET password_hash = $1 WHERE id = $2", [passwordHash, userId]);
}
