import { pool, withTransaction } from "../db";
import { recordAuditEvent } from "../audit";
import { assertPasswordStrength, hashPassword } from "../auth/password";
import { revokeAllSessionsForUser } from "../auth/session";
import { ConflictError, NotFoundError, ValidationError, isUniqueViolation } from "../errors";
import type { Role } from "../authz";
import type { RequestContext } from "../context";
import {
  countOtherActiveOwners,
  createMembership,
  findTeamMember,
  listTeamMembers,
  updateMembershipRole,
  updateMembershipStatus,
  type MemberStatus,
  type TeamMemberRow,
} from "../repositories/memberships";
import type { InviteMemberBody, UpdateMemberBody } from "../validation/schemas";

/**
 * SAAS-02: the establishment's team, administered by its owner alone
 * (`users:manage`, DEC-07).
 *
 * Every function here re-reads the target *through this location's
 * memberships* before touching it. That is not defensive noise: the user id
 * comes from the client, and a scoped lookup is what turns an id belonging
 * to another tenant into a 404 rather than a row this owner can rewrite
 * (SEC-06/SEC-08).
 */

export async function listTeam(context: RequestContext): Promise<TeamMemberRow[]> {
  return listTeamMembers(pool, context.locationId);
}

/**
 * Adds a member with an initial password the owner sets and hands over.
 *
 * There is no e-mailed invitation because there is no mail transport in
 * this codebase at all — the password reset flow (SEC-03) already returns
 * its token to the caller in development and simply logs it in production,
 * and no task in the backlog introduces one. Inventing a token that nothing
 * can deliver would be a screen that appears to work and does not; in a bar
 * or a restaurant the owner and the new employee are in the same room, so
 * the honest MVP is an initial password stated out loud and changed by the
 * employee through "mot de passe oublié" whenever they want.
 *
 * An e-mail that already has an account is refused rather than attached to
 * this organization. `memberships` would accept it — a person can hold one
 * membership per organization — but silently pulling an existing account
 * into an establishment would give that establishment's data to someone who
 * never agreed to it, on the say-so of an owner who only had to guess an
 * address. Multi-establishment staff is out of DEC-01's MVP scope.
 */
export async function inviteMember(
  context: RequestContext,
  input: InviteMemberBody,
): Promise<TeamMemberRow> {
  assertPasswordStrength(input.password);
  const passwordHash = await hashPassword(input.password);

  try {
    return await withTransaction(async (client) => {
      const {
        rows: [user],
      } = await client.query<{ id: number }>(
        "INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id",
        [input.email, passwordHash, input.name],
      );
      await createMembership(client, {
        userId: user.id,
        organizationId: context.organizationId,
        locationId: context.locationId,
        role: input.role,
      });
      await recordAuditEvent(client, {
        locationId: context.locationId,
        actorUserId: context.userId,
        action: "user.invite",
        targetType: "user",
        targetId: user.id,
        after: { email: input.email, name: input.name, role: input.role },
      });

      const member = await findTeamMember(client, context.locationId, user.id);
      return member!;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError("Un compte existe déjà avec cette adresse e-mail.");
    }
    throw error;
  }
}

export async function changeMemberRole(
  context: RequestContext,
  userId: number,
  role: Role,
): Promise<TeamMemberRow> {
  return withTransaction(async (client) => {
    const member = await requireMember(client, context, userId);
    if (member.role === role) return member;

    if (member.role === "OWNER") {
      await assertAnotherOwnerRemains(
        client,
        context,
        userId,
        "Cet établissement doit garder au moins un propriétaire actif : nommez d'abord un autre propriétaire.",
      );
    }

    await updateMembershipRole(client, context.locationId, userId, role);
    await recordAuditEvent(client, {
      locationId: context.locationId,
      actorUserId: context.userId,
      action: "user.role_change",
      targetType: "user",
      targetId: userId,
      before: { role: member.role },
      after: { role },
    });
    return { ...member, role };
  });
}

export async function setMemberStatus(
  context: RequestContext,
  userId: number,
  isActive: boolean,
): Promise<TeamMemberRow> {
  const status: MemberStatus = isActive ? "ACTIVE" : "DISABLED";

  const member = await withTransaction(async (client) => {
    const current = await requireMember(client, context, userId);
    if (current.status === status) return current;

    if (!isActive) {
      // Two different mistakes, two different messages. Locking yourself
      // out is recoverable only by another owner, and being the last owner
      // is recoverable by nobody — telling the person which one they just
      // hit is the difference between a fixable slip and a mystery.
      if (userId === context.userId) {
        throw new ValidationError(
          "Vous ne pouvez pas désactiver votre propre compte : demandez à un autre propriétaire.",
        );
      }
      if (current.role === "OWNER") {
        await assertAnotherOwnerRemains(
          client,
          context,
          userId,
          "Cet établissement doit garder au moins un propriétaire actif.",
        );
      }
    }

    await updateMembershipStatus(client, context.locationId, userId, status);
    await recordAuditEvent(client, {
      locationId: context.locationId,
      actorUserId: context.userId,
      action: isActive ? "user.enable" : "user.disable",
      targetType: "user",
      targetId: userId,
      before: { status: current.status },
      after: { status },
    });
    return { ...current, status };
  });

  if (!isActive) {
    // Belt and braces. findAuthenticatedSession already refuses a session
    // whose membership is DISABLED, so the person is locked out the instant
    // the transaction commits whether or not this runs; deleting the rows
    // means a re-enabled account starts from a fresh login rather than
    // resuming a session opened before the suspension.
    await revokeAllSessionsForUser(pool, userId);
  }
  return member;
}

async function requireMember(
  client: Parameters<typeof findTeamMember>[0],
  context: RequestContext,
  userId: number,
): Promise<TeamMemberRow> {
  const member = await findTeamMember(client, context.locationId, userId);
  if (!member) throw new NotFoundError("Ce membre est introuvable dans cet établissement.");
  return member;
}

async function assertAnotherOwnerRemains(
  client: Parameters<typeof countOtherActiveOwners>[0],
  context: RequestContext,
  userId: number,
  message: string,
): Promise<void> {
  const remaining = await countOtherActiveOwners(client, context.locationId, userId);
  if (remaining === 0) throw new ValidationError(message);
}
