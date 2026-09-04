import type { Queryable } from "../db";
import type { Role } from "../authz";

export type MemberStatus = "ACTIVE" | "DISABLED";

export interface TeamMemberRow {
  user_id: number;
  name: string;
  email: string;
  role: Role;
  /**
   * The membership's own status. `users.status` is the account-wide switch
   * and is not exposed here: this screen administers one establishment's
   * team, and an owner has no business flipping a global account flag from
   * it. Both are checked at authentication (lib/auth/session.ts).
   */
  status: MemberStatus;
  created_at: string;
}

/**
 * SAAS-02: the establishment's team.
 *
 * Scoped by `location_id` like every other repository here (SEC-06). That
 * is what keeps an owner's reach inside their own establishment: the
 * mutations below take a user id from the client, and joining through
 * `memberships` on this location is what makes an id from another tenant
 * simply not found rather than editable.
 */
export async function listTeamMembers(db: Queryable, locationId: number): Promise<TeamMemberRow[]> {
  const { rows } = await db.query<TeamMemberRow>(
    `SELECT u.id AS user_id, u.name, u.email, m.role, m.status, m.created_at
       FROM memberships m
       JOIN users u ON u.id = m.user_id
      WHERE m.location_id = $1
      ORDER BY m.created_at ASC, u.id ASC`,
    [locationId],
  );
  return rows;
}

export async function findTeamMember(
  db: Queryable,
  locationId: number,
  userId: number,
): Promise<TeamMemberRow | null> {
  const { rows } = await db.query<TeamMemberRow>(
    `SELECT u.id AS user_id, u.name, u.email, m.role, m.status, m.created_at
       FROM memberships m
       JOIN users u ON u.id = m.user_id
      WHERE m.location_id = $1 AND m.user_id = $2`,
    [locationId, userId],
  );
  return rows[0] ?? null;
}

/**
 * Counts the establishment's active owners, excluding one user.
 *
 * The exclusion is the point: both callers ask the same question — "if I
 * demote or disable this person, is anyone left who can administer the
 * establishment?" — and `FOR UPDATE` makes the answer hold for the rest of
 * the transaction. Without the lock, two owners demoting each other at the
 * same instant each read the other as still active, both writes land, and
 * the establishment is left with settings and a team nobody can touch again
 * without SQL.
 *
 * The lock covers *every* active owner of the establishment, which is what
 * serialises the two transactions; READ COMMITTED then re-evaluates the row
 * once the lock is granted, so the second one sees the first one's
 * demotion.
 */
export async function countOtherActiveOwners(
  db: Queryable,
  locationId: number,
  excludedUserId: number,
): Promise<number> {
  const { rows } = await db.query<{ user_id: number }>(
    `SELECT user_id FROM memberships
      WHERE location_id = $1 AND role = 'OWNER' AND status = 'ACTIVE'
      FOR UPDATE`,
    [locationId],
  );
  // The exclusion is applied here, after the lock, and not in the SQL. As a
  // `WHERE user_id <> $2` it looked equivalent, but the planner pushes that
  // filter below `LockRows` (confirmed with EXPLAIN), so each transaction
  // locked only the *other* owners — disjoint sets, no contention, and the
  // race this function exists to close stayed wide open.
  return rows.filter((row) => row.user_id !== excludedUserId).length;
}

export async function createMembership(
  db: Queryable,
  input: { userId: number; organizationId: number; locationId: number; role: Role },
): Promise<void> {
  await db.query(
    `INSERT INTO memberships (user_id, organization_id, location_id, role)
     VALUES ($1, $2, $3, $4)`,
    [input.userId, input.organizationId, input.locationId, input.role],
  );
}

export async function updateMembershipRole(
  db: Queryable,
  locationId: number,
  userId: number,
  role: Role,
): Promise<void> {
  await db.query("UPDATE memberships SET role = $1 WHERE location_id = $2 AND user_id = $3", [
    role,
    locationId,
    userId,
  ]);
}

export async function updateMembershipStatus(
  db: Queryable,
  locationId: number,
  userId: number,
  status: MemberStatus,
): Promise<void> {
  await db.query("UPDATE memberships SET status = $1 WHERE location_id = $2 AND user_id = $3", [
    status,
    locationId,
    userId,
  ]);
}

/**
 * Whether this account still has somewhere to sign in to.
 *
 * Deliberately not location-scoped, for the same reason
 * `users.ts::findUserByEmail` is not: authentication happens before a
 * location is known — the membership lookup that resolves one comes right
 * after. It is never used to serve business data.
 */
export async function hasActiveMembership(db: Queryable, userId: number): Promise<boolean> {
  const { rows } = await db.query(
    "SELECT 1 FROM memberships WHERE user_id = $1 AND status = 'ACTIVE' LIMIT 1",
    [userId],
  );
  return rows.length > 0;
}
