import { beforeEach, describe, expect, it } from "vitest";
import { listAuditEvents } from "../../lib/audit";
import { login } from "../../lib/auth/service";
import { createSession, findAuthenticatedSession } from "../../lib/auth/session";
import { pool } from "../../lib/db";
import {
  ConflictError,
  NotFoundError,
  UnauthenticatedError,
  ValidationError,
} from "../../lib/errors";
import { countOtherActiveOwners, updateMembershipRole } from "../../lib/repositories/memberships";
import { changeMemberRole, inviteMember, listTeam, setMemberStatus } from "../../lib/services/team";
import { createTestTenant, createTestUser, type TestTenant } from "./helpers/fixtures";
import { resetDatabase } from "./helpers/reset-database";
import type { RequestContext } from "../../lib/context";
import type { Role } from "../../lib/authz";

/**
 * SAAS-02: "seuls les rôles autorisés administrent l'équipe ; actions
 * auditées."
 *
 * The permission half of that is `requirePermission(role, "users:manage")`
 * at the routes, whose matrix is asserted line by line in
 * tests/unit/authz.test.ts and end to end over HTTP in
 * tests/e2e/team.spec.ts. What is left here — and only reachable here — is
 * what the service refuses even to an owner who *does* hold the permission:
 * emptying an establishment of its owners, locking oneself out, or reaching
 * across a tenant boundary.
 */

let tenant: TestTenant;
let owner: RequestContext;

async function contextFor(role: Role, on: TestTenant = tenant): Promise<RequestContext> {
  const user = await createTestUser(pool, on, role);
  return {
    userId: user.userId,
    userEmail: user.email,
    userName: role,
    organizationId: on.organizationId,
    locationId: on.locationId,
    role,
    sessionId: 1,
  };
}

function invitation(overrides: Partial<Parameters<typeof inviteMember>[1]> = {}) {
  return {
    name: "Sarah Bernard",
    email: `sarah-${crypto.randomUUID().slice(0, 8)}@example.test`,
    password: "Password123!",
    role: "CASHIER" as Role,
    ...overrides,
  };
}

beforeEach(async () => {
  await resetDatabase(pool);
  tenant = await createTestTenant(pool);
  owner = await contextFor("OWNER");
});

describe("team administration (SAAS-02)", () => {
  it("adds a member who can immediately sign in with the role they were given", async () => {
    const input = invitation({ role: "MANAGER" });
    const member = await inviteMember(owner, input);

    expect(member).toMatchObject({ name: input.name, email: input.email, role: "MANAGER" });
    expect(member.status).toBe("ACTIVE");

    // The proof that the invitation produced a usable account, not just two
    // rows: the person can authenticate and lands on the right tenant.
    const session = await login({
      email: input.email,
      password: input.password,
      ipAddress: null,
      userAgent: null,
    });
    const resolved = await findAuthenticatedSession(pool, session.token);
    expect(resolved?.role).toBe("MANAGER");
    expect(resolved?.locationId).toBe(tenant.locationId);
  });

  it("lists the establishment's members, the owner included", async () => {
    await inviteMember(owner, invitation({ name: "Sarah Bernard" }));

    const team = await listTeam(owner);
    expect(team.map((member) => member.user_id)).toContain(owner.userId);
    expect(team.map((member) => member.name)).toContain("Sarah Bernard");
    expect(team).toHaveLength(2);
  });

  it("refuses an e-mail that already has an account", async () => {
    const input = invitation();
    await inviteMember(owner, input);

    await expect(
      inviteMember(owner, invitation({ email: input.email.toUpperCase() })),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("writes nothing when the initial password is too weak", async () => {
    await expect(inviteMember(owner, invitation({ password: "court" }))).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(await listTeam(owner)).toHaveLength(1);
  });

  it("changes a role and records what it was before", async () => {
    const member = await inviteMember(owner, invitation({ role: "CASHIER" }));

    const updated = await changeMemberRole(owner, member.user_id, "MANAGER");
    expect(updated.role).toBe("MANAGER");
    // Re-read, not just the returned object: the service builds its result
    // in memory, so asserting on it alone would pass even if nothing was
    // written.
    const team = await listTeam(owner);
    expect(team.find((row) => row.user_id === member.user_id)?.role).toBe("MANAGER");

    const events = await listAuditEvents(pool, tenant.locationId, { limit: 50 });
    const roleChange = events.find((event) => event.action === "user.role_change");
    expect(roleChange).toMatchObject({
      actorUserId: owner.userId,
      targetType: "user",
      targetId: String(member.user_id),
      before: { role: "CASHIER" },
      after: { role: "MANAGER" },
    });
  });

  it("audits an invitation, a suspension and a restoration", async () => {
    const member = await inviteMember(owner, invitation());
    await setMemberStatus(owner, member.user_id, false);
    await setMemberStatus(owner, member.user_id, true);

    const events = await listAuditEvents(pool, tenant.locationId, { limit: 50 });
    expect(events.map((event) => event.action)).toEqual(
      expect.arrayContaining(["user.invite", "user.disable", "user.enable"]),
    );
  });

  it("locks a suspended member out immediately, session and password alike", async () => {
    const input = invitation();
    const member = await inviteMember(owner, input);

    // A session opened *before* the suspension, to prove it stops working
    // rather than merely being refused at the next login.
    const opened = await createSession(pool, member.user_id, {});
    expect(await findAuthenticatedSession(pool, opened.token)).not.toBeNull();

    await setMemberStatus(owner, member.user_id, false);

    expect(await findAuthenticatedSession(pool, opened.token)).toBeNull();
    await expect(
      login({ email: input.email, password: input.password, ipAddress: null, userAgent: null }),
    ).rejects.toBeInstanceOf(UnauthenticatedError);

    await setMemberStatus(owner, member.user_id, true);
    const back = await login({
      email: input.email,
      password: input.password,
      ipAddress: null,
      userAgent: null,
    });
    expect(back.token).toBeTruthy();
  });

  it("refuses to demote the establishment's last active owner", async () => {
    await expect(changeMemberRole(owner, owner.userId, "MANAGER")).rejects.toBeInstanceOf(
      ValidationError,
    );
    const team = await listTeam(owner);
    expect(team.find((member) => member.user_id === owner.userId)?.role).toBe("OWNER");
  });

  it("allows demoting an owner once another active owner exists", async () => {
    const second = await inviteMember(owner, invitation({ role: "OWNER" }));

    const updated = await changeMemberRole(owner, owner.userId, "MANAGER");
    expect(updated.role).toBe("MANAGER");
    const team = await listTeam(owner);
    expect(team.find((member) => member.user_id === second.user_id)?.role).toBe("OWNER");
  });

  it("serialises two owners demoting each other, instead of letting both through", async () => {
    const second = await contextFor("OWNER");

    // Driven with two explicit connections rather than two concurrent
    // service calls: those interleave only by luck of connection timing —
    // the version of this test that just raced two `changeMemberRole`
    // promises passed with the lock *removed*, which makes it a test of
    // nothing. Here the overlap is forced, so the assertion is about the
    // lock and not about scheduling.
    const first = await pool.connect();
    const other = await pool.connect();
    try {
      await first.query("BEGIN");
      await other.query("BEGIN");

      // Holds the lock on every active owner of this establishment.
      expect(await countOtherActiveOwners(first, tenant.locationId, owner.userId)).toBe(1);

      let otherAnswered = false;
      const blocked = countOtherActiveOwners(other, tenant.locationId, second.userId).then(
        (count) => {
          otherAnswered = true;
          return count;
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(otherAnswered, "the second owner's check must wait for the first").toBe(false);

      await updateMembershipRole(first, tenant.locationId, owner.userId, "MANAGER");
      await first.query("COMMIT");

      // READ COMMITTED re-evaluates the row once the lock is granted, so
      // the second transaction sees the demotion that just committed and
      // finds itself alone — which is what refuses it.
      expect(await blocked).toBe(0);
      await other.query("ROLLBACK");
    } finally {
      first.release();
      other.release();
    }
  });

  it("counts only *active* owners when deciding whether one is the last", async () => {
    const second = await inviteMember(owner, invitation({ role: "OWNER" }));
    await setMemberStatus(owner, second.user_id, false);

    // A suspended owner cannot administer anything, so they do not make the
    // remaining one demotable.
    await expect(changeMemberRole(owner, owner.userId, "CASHIER")).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("refuses to suspend the last active owner", async () => {
    const second = await contextFor("OWNER");
    await expect(setMemberStatus(second, owner.userId, false)).resolves.toMatchObject({
      status: "DISABLED",
    });
    // `second` is now alone: suspending them would leave the establishment
    // with nobody able to restore anyone.
    const third = await contextFor("MANAGER");
    await expect(setMemberStatus(third, second.userId, false)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("refuses to let an owner suspend their own account", async () => {
    await contextFor("OWNER"); // another owner exists, so this is not the last-owner rule
    await expect(setMemberStatus(owner, owner.userId, false)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("does not reach members of another establishment", async () => {
    const otherTenant = await createTestTenant(pool, "Other Org");
    const stranger = await contextFor("CASHIER", otherTenant);

    await expect(changeMemberRole(owner, stranger.userId, "OWNER")).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(setMemberStatus(owner, stranger.userId, false)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(await listTeam(owner)).toHaveLength(1);
  });

  it("keeps a member added by one establishment invisible to another", async () => {
    await inviteMember(owner, invitation({ name: "Sarah Bernard" }));
    const otherTenant = await createTestTenant(pool, "Other Org");
    const otherOwner = await contextFor("OWNER", otherTenant);

    expect((await listTeam(otherOwner)).map((member) => member.name)).not.toContain(
      "Sarah Bernard",
    );
  });
});
