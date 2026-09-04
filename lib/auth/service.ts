import { pool, withTransaction } from "../db";
import { logger } from "../logger";
import { TooManyRequestsError, UnauthenticatedError, ValidationError } from "../errors";
import { hasActiveMembership } from "../repositories/memberships";
import { findUserByEmail, updateUserPassword } from "../repositories/users";
import { assertPasswordStrength, hashPassword, verifyPassword } from "./password";
import {
  createPasswordResetToken,
  findValidPasswordResetToken,
  markPasswordResetTokenUsed,
} from "./password-reset";
import { isLoginRateLimited, recordLoginAttempt } from "./rate-limit";
import { createSession, revokeAllSessionsForUser, revokeSessionByToken } from "./session";
import { parseOrThrow } from "../validation/parse";
import { credentialsSchema } from "../validation/schemas";

/**
 * A syntactically valid bcrypt hash that matches no real password. Running
 * verifyPassword against it even when the email is unknown keeps the "user
 * not found" and "wrong password" code paths taking roughly the same time,
 * which is cheap insurance against trivial timing-based user enumeration.
 */
const DUMMY_PASSWORD_HASH = "$2a$10$C6UzMDM.H6dfI/f/IKcEeO0fFvXsBdBnRP.SoOCF.oW0j5r08zSHu";

export interface LoginInput {
  email: string;
  password: string;
  ipAddress: string | null;
  userAgent: string | null;
}

export interface LoginResult {
  token: string;
  expiresAt: Date;
}

/** SEC-03: validates credentials, enforces brute-force limits, and returns a fresh session token. */
export async function login(input: LoginInput): Promise<LoginResult> {
  // Revalidated here even though the route already parsed the body
  // (API-01): login is also reachable from tests and future non-HTTP entry
  // points, and this is the function that decides whether a password is
  // checked at all.
  const { email, password } = parseOrThrow(
    credentialsSchema,
    { email: input.email, password: input.password },
    "Identifiants invalides.",
  );

  if (await isLoginRateLimited(pool, email, input.ipAddress)) {
    throw new TooManyRequestsError(
      "Trop de tentatives de connexion. Réessayez dans quelques minutes.",
    );
  }

  const user = await findUserByEmail(pool, email);
  const passwordMatches = await verifyPassword(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);

  // SAAS-02: a suspended *membership* has to be refused here too, not only
  // when the session is later resolved. `users.status` is the account-wide
  // switch and nothing in the product sets it; what an owner suspends is the
  // membership (memberships.status), and until this check existed such a
  // person still received a valid-looking token, saw the login succeed, and
  // was bounced by the first protected page — an account that appears to
  // work and does not. Checked after the password so a wrong password and a
  // suspended account remain indistinguishable (SEC-03).
  const membershipActive = user ? await hasActiveMembership(pool, user.id) : false;

  if (!user || user.status !== "ACTIVE" || !membershipActive || !passwordMatches) {
    await recordLoginAttempt(pool, email, input.ipAddress, false);
    throw new UnauthenticatedError("Identifiants invalides.");
  }

  await recordLoginAttempt(pool, email, input.ipAddress, true);
  const session = await createSession(pool, user.id, {
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
  });
  logger.info("login succeeded", { userId: user.id });
  return { token: session.token, expiresAt: session.expiresAt };
}

export async function logout(token: string): Promise<void> {
  await revokeSessionByToken(pool, token);
}

export interface PasswordResetRequestResult {
  token: string;
  expiresAt: Date;
}

/**
 * Always returns null to the caller when the email is unknown (SEC-03: never
 * reveal account existence). No transactional email provider is wired up
 * yet, so the raw token is logged server-side for an operator to relay, and
 * — outside production only — also returned to the caller so local/dev/CI
 * testing does not require reading server logs. Wiring a real provider is
 * tracked as an OPS-05 (phase 7) deployment prerequisite, not silently
 * faked here.
 */
export async function requestPasswordReset(
  email: string,
): Promise<PasswordResetRequestResult | null> {
  const user = await findUserByEmail(pool, email);
  if (!user) {
    logger.info("password reset requested for unknown email");
    return null;
  }

  const created = await createPasswordResetToken(pool, user.id);
  logger.info("password reset token issued", { userId: user.id });

  if (process.env.NODE_ENV === "production") {
    return null;
  }
  return created;
}

export async function confirmPasswordReset(token: string, newPassword: string): Promise<void> {
  assertPasswordStrength(newPassword);
  const valid = await findValidPasswordResetToken(pool, token);
  if (!valid) {
    throw new ValidationError("Ce lien de réinitialisation est invalide ou a expiré.");
  }

  const passwordHash = await hashPassword(newPassword);
  await withTransaction(async (client) => {
    await updateUserPassword(client, valid.userId, passwordHash);
    await markPasswordResetTokenUsed(client, valid.id);
    // A password reset is a strong signal to end every other active
    // session immediately (SEC-03 "révocation").
    await revokeAllSessionsForUser(client, valid.userId);
  });
  logger.info("password reset confirmed", { userId: valid.userId });
}
