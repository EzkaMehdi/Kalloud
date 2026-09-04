import { beforeEach, describe, expect, it } from "vitest";
import { pool } from "../../lib/db";
import { confirmPasswordReset, login, logout, requestPasswordReset } from "../../lib/auth/service";
import { findAuthenticatedSession } from "../../lib/auth/session";
import { isLoginRateLimited } from "../../lib/auth/rate-limit";
import {
  ForbiddenError,
  TooManyRequestsError,
  UnauthenticatedError,
  ValidationError,
} from "../../lib/errors";
import { createTestTenant, createTestUser } from "./helpers/fixtures";
import { resetDatabase } from "./helpers/reset-database";

// vitest.config.ts pins DATABASE_URL to DATABASE_URL_TEST for this project,
// so lib/db.ts's own pool already points at the dedicated test database —
// exercising the exact same pool the application uses is the point.
beforeEach(async () => {
  await resetDatabase(pool);
});

describe("authentication service (SEC-03)", () => {
  it("logs a valid user in and returns a session token", async () => {
    const tenant = await createTestTenant(pool);
    const user = await createTestUser(pool, tenant, "OWNER");

    const result = await login({
      email: user.email,
      password: user.password,
      ipAddress: "127.0.0.1",
      userAgent: "vitest",
    });

    expect(result.token).toBeTruthy();
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const session = await findAuthenticatedSession(pool, result.token);
    expect(session).not.toBeNull();
    expect(session?.userId).toBe(user.userId);
    expect(session?.role).toBe("OWNER");
    expect(session?.organizationId).toBe(tenant.organizationId);
    expect(session?.locationId).toBe(tenant.locationId);
  });

  it("rejects an invalid password without revealing which part was wrong", async () => {
    const tenant = await createTestTenant(pool);
    const user = await createTestUser(pool, tenant, "CASHIER");

    await expect(
      login({
        email: user.email,
        password: "WrongPassword1!",
        ipAddress: "127.0.0.1",
        userAgent: null,
      }),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it("rejects an unknown email with the same error as a wrong password", async () => {
    await expect(
      login({
        email: "nobody@example.test",
        password: "WhateverPassword1!",
        ipAddress: "127.0.0.1",
        userAgent: null,
      }),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it("rejects a disabled membership even with correct credentials", async () => {
    const tenant = await createTestTenant(pool);
    const user = await createTestUser(pool, tenant, "MANAGER");
    await pool.query("UPDATE memberships SET status = 'DISABLED' WHERE user_id = $1", [
      user.userId,
    ]);

    // Refused at the login itself since SAAS-02. This test previously
    // asserted the opposite half of the same guarantee — that login
    // *succeeded* and only `findAuthenticatedSession` refused to resolve a
    // context — which was true while nothing in the product ever set
    // `memberships.status = 'DISABLED'`. Now that suspending a member is a
    // button, that behaviour would hand a suspended employee a successful
    // login followed by an immediate bounce. The user row itself stays
    // ACTIVE: what is suspended is the membership.
    await expect(
      login({
        email: user.email,
        password: user.password,
        ipAddress: "127.0.0.1",
        userAgent: null,
      }),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it("still refuses to resolve a session opened before the membership was disabled", async () => {
    const tenant = await createTestTenant(pool);
    const user = await createTestUser(pool, tenant, "MANAGER");
    const result = await login({
      email: user.email,
      password: user.password,
      ipAddress: "127.0.0.1",
      userAgent: null,
    });

    await pool.query("UPDATE memberships SET status = 'DISABLED' WHERE user_id = $1", [
      user.userId,
    ]);

    // The second layer, kept: `findAuthenticatedSession` joins on an ACTIVE
    // membership, so an already-issued token stops resolving whether or not
    // anything revoked it.
    expect(await findAuthenticatedSession(pool, result.token)).toBeNull();
  });

  it("locks out further attempts after repeated failures for the same email", async () => {
    const tenant = await createTestTenant(pool);
    const user = await createTestUser(pool, tenant, "OWNER");

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(
        login({
          email: user.email,
          password: "WrongPassword1!",
          ipAddress: "10.0.0.1",
          userAgent: null,
        }),
      ).rejects.toBeInstanceOf(UnauthenticatedError);
    }

    expect(await isLoginRateLimited(pool, user.email, "10.0.0.1")).toBe(true);
    await expect(
      login({ email: user.email, password: user.password, ipAddress: "10.0.0.1", userAgent: null }),
    ).rejects.toBeInstanceOf(TooManyRequestsError);
  });

  it("revokes the session on logout so it can no longer authenticate", async () => {
    const tenant = await createTestTenant(pool);
    const user = await createTestUser(pool, tenant, "OWNER");
    const { token } = await login({
      email: user.email,
      password: user.password,
      ipAddress: null,
      userAgent: null,
    });

    expect(await findAuthenticatedSession(pool, token)).not.toBeNull();
    await logout(token);
    expect(await findAuthenticatedSession(pool, token)).toBeNull();
  });

  it("resets a forgotten password and revokes every existing session", async () => {
    const tenant = await createTestTenant(pool);
    const user = await createTestUser(pool, tenant, "MANAGER");
    const { token: sessionBeforeReset } = await login({
      email: user.email,
      password: user.password,
      ipAddress: null,
      userAgent: null,
    });

    const resetRequest = await requestPasswordReset(user.email);
    expect(resetRequest).not.toBeNull();

    await confirmPasswordReset(resetRequest!.token, "BrandNewPassword1!");

    // Old session is gone...
    expect(await findAuthenticatedSession(pool, sessionBeforeReset)).toBeNull();
    // ...the old password no longer works...
    await expect(
      login({ email: user.email, password: user.password, ipAddress: null, userAgent: null }),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
    // ...and the new one does.
    const relogged = await login({
      email: user.email,
      password: "BrandNewPassword1!",
      ipAddress: null,
      userAgent: null,
    });
    expect(relogged.token).toBeTruthy();
  });

  it("does not reveal whether an email exists when requesting a reset", async () => {
    await expect(requestPasswordReset("nobody@example.test")).resolves.toBeNull();
  });

  it("rejects a weak new password on reset confirmation", async () => {
    const tenant = await createTestTenant(pool);
    const user = await createTestUser(pool, tenant, "OWNER");
    const resetRequest = await requestPasswordReset(user.email);

    await expect(confirmPasswordReset(resetRequest!.token, "short")).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("rejects an expired or already-used reset token", async () => {
    const tenant = await createTestTenant(pool);
    const user = await createTestUser(pool, tenant, "OWNER");
    const resetRequest = await requestPasswordReset(user.email);

    await confirmPasswordReset(resetRequest!.token, "FirstNewPassword1!");
    await expect(
      confirmPasswordReset(resetRequest!.token, "SecondNewPassword1!"),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("ForbiddenError sanity (shared with SEC-05 unit tests)", () => {
  it("carries a 403 status code", () => {
    expect(new ForbiddenError().statusCode).toBe(403);
  });
});
