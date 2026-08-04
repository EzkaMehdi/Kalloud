import bcrypt from "bcryptjs";
import { ValidationError } from "../errors";

// bcryptjs is pure JS (no native build step), which keeps `pnpm install`
// portable across CI/deploy targets at the cost of a few extra milliseconds
// per hash versus a native implementation -- an acceptable trade for MVP
// scale (DEC-02).
const SALT_ROUNDS = 10;
const MIN_PASSWORD_LENGTH = 8;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/** Minimal strength gate for SEC-03. Throws a ValidationError with a message safe to show the user. */
export function assertPasswordStrength(password: string): void {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    throw new ValidationError(
      `Le mot de passe doit contenir au moins ${MIN_PASSWORD_LENGTH} caractères.`,
    );
  }
}
