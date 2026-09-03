import { withTransaction } from "../db";
import { recordAuditEvent } from "../audit";
import { ConflictError, isUniqueViolation } from "../errors";
import { assertPasswordStrength, hashPassword } from "../auth/password";
import { createSession } from "../auth/session";

export interface CreateEstablishmentInput {
  establishmentName: string;
  ownerName: string;
  email: string;
  password: string;
  ipAddress: string | null;
  userAgent: string | null;
}

export interface CreateEstablishmentResult {
  token: string;
  expiresAt: Date;
  organizationId: number;
  locationId: number;
  userId: number;
}

/**
 * SAAS-01: everything a new customer needs in order to exist, created in one
 * transaction and without anyone opening a SQL client.
 *
 * This is the first of DEC-01's mandatory journeys ("créer son compte et son
 * établissement"), and until now the only way to perform it was by hand:
 * `scripts/seed.mjs` for the demo tenant, raw `INSERT`s in the test helpers
 * for everything else. That is exactly what the acceptance criterion
 * forbids — "aucun SQL ou seed manuel pour un nouveau client".
 *
 * Five rows, one transaction, on purpose. A partially created customer is
 * worse than none: an organization without a location, or an owner without a
 * membership, produces an account that authenticates and then resolves no
 * tenant — a state no screen in the application knows how to render, and one
 * that would need the very SQL console this ticket removes to repair.
 *
 * `location_settings` is inserted with no values at all: every column has a
 * default (`Europe/Paris`, `EUR`, 20 %, 5 € threshold — migrations/0002),
 * and the establishment adjusts them afterwards through CFG-01. Naming them
 * here would fork the defaults into a second place that could drift.
 *
 * No tax class is created either. DEC-05's fallback chain ends at
 * `location_settings.default_tax_rate` (see products.ts's shared join), so a
 * catalogue priced from day one is taxed correctly without one; classes are
 * an optional refinement the owner adds when they need a second rate.
 */
export async function createEstablishment(
  input: CreateEstablishmentInput,
): Promise<CreateEstablishmentResult> {
  // Checked before the transaction opens: a weak password is the caller's
  // mistake to fix, not a reason to have held a write lock.
  assertPasswordStrength(input.password);
  const passwordHash = await hashPassword(input.password);

  try {
    return await withTransaction(async (client) => {
      const {
        rows: [organization],
      } = await client.query<{ id: number }>(
        "INSERT INTO organizations (name) VALUES ($1) RETURNING id",
        [input.establishmentName],
      );
      const {
        rows: [location],
      } = await client.query<{ id: number }>(
        "INSERT INTO locations (organization_id, name) VALUES ($1, $2) RETURNING id",
        [organization.id, input.establishmentName],
      );
      await client.query("INSERT INTO location_settings (location_id) VALUES ($1)", [location.id]);

      const {
        rows: [user],
      } = await client.query<{ id: number }>(
        "INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id",
        [input.email, passwordHash, input.ownerName],
      );
      await client.query(
        "INSERT INTO memberships (user_id, organization_id, location_id, role) VALUES ($1, $2, $3, 'OWNER')",
        [user.id, organization.id, location.id],
      );

      await recordAuditEvent(client, {
        locationId: location.id,
        actorUserId: user.id,
        action: "establishment.create",
        targetType: "location",
        targetId: location.id,
        after: { name: input.establishmentName, ownerEmail: input.email },
      });

      // Signed in immediately: the next thing this person must do is
      // configure tables and a catalogue, and sending them to a login form
      // to retype the password they just chose would be a step that exists
      // only because the code did not carry them across.
      const session = await createSession(client, user.id, {
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
      });

      return {
        token: session.token,
        expiresAt: session.expiresAt,
        organizationId: organization.id,
        locationId: location.id,
        userId: user.id,
      };
    });
  } catch (error) {
    // `users_email_unique_idx` is on `lower(email)`. Unlike login and
    // password reset — where confirming an address exists would be
    // enumeration — a signup form has no way to be useful without saying
    // so: the person is trying to claim this address and needs to know it
    // is taken.
    if (isUniqueViolation(error)) {
      throw new ConflictError("Un compte existe déjà avec cette adresse e-mail.");
    }
    throw error;
  }
}
