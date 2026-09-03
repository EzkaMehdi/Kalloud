import { beforeEach, describe, expect, it } from "vitest";
import { pool } from "../../lib/db";
import { findAuthenticatedSession } from "../../lib/auth/session";
import { ConflictError, ValidationError } from "../../lib/errors";
import { createEstablishment } from "../../lib/services/onboarding";
import { resetDatabase } from "./helpers/reset-database";

beforeEach(async () => {
  await resetDatabase(pool);
});

function input(overrides: Partial<Parameters<typeof createEstablishment>[0]> = {}) {
  return {
    establishmentName: "Le Comptoir",
    ownerName: "Alice Martin",
    email: "alice@comptoir.test",
    password: "Password123!",
    ipAddress: "127.0.0.1",
    userAgent: "vitest",
    ...overrides,
  };
}

describe("initial onboarding (SAAS-01)", () => {
  it("creates a complete, usable establishment without any manual SQL", async () => {
    const result = await createEstablishment(input());

    // The acceptance criterion is that nothing else has to be inserted by
    // hand, so the assertion is on all five rows, not just the user.
    const { rows: organizations } = await pool.query(
      "SELECT id, name FROM organizations WHERE id = $1",
      [result.organizationId],
    );
    expect(organizations).toHaveLength(1);
    expect(organizations[0].name).toBe("Le Comptoir");

    const { rows: locations } = await pool.query(
      "SELECT organization_id, name FROM locations WHERE id = $1",
      [result.locationId],
    );
    expect(locations[0].organization_id).toBe(result.organizationId);

    const { rows: memberships } = await pool.query(
      "SELECT role, organization_id, location_id FROM memberships WHERE user_id = $1",
      [result.userId],
    );
    expect(memberships).toEqual([
      {
        role: "OWNER",
        organization_id: result.organizationId,
        location_id: result.locationId,
      },
    ]);
  });

  it("applies the schema defaults to location_settings so the tenant is priced correctly from the start", async () => {
    const result = await createEstablishment(input());

    // DEC-05's tax fallback chain ends here: with no tax class, a product's
    // rate comes from these settings. A missing row would leave the very
    // first sale untaxable.
    const { rows } = await pool.query(
      "SELECT timezone, currency, default_tax_rate FROM location_settings WHERE location_id = $1",
      [result.locationId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].timezone).toBe("Europe/Paris");
    expect(rows[0].currency).toBe("EUR");
    expect(Number(rows[0].default_tax_rate)).toBe(20);
  });

  it("signs the owner in on the establishment it just created", async () => {
    const result = await createEstablishment(input());

    const session = await findAuthenticatedSession(pool, result.token);
    expect(session).not.toBeNull();
    expect(session?.userId).toBe(result.userId);
    expect(session?.role).toBe("OWNER");
    expect(session?.organizationId).toBe(result.organizationId);
    expect(session?.locationId).toBe(result.locationId);
  });

  it("records the creation in the audit trail", async () => {
    const result = await createEstablishment(input());

    const { rows } = await pool.query(
      "SELECT action, actor_user_id, target_type, target_id FROM audit_events WHERE location_id = $1",
      [result.locationId],
    );
    expect(rows).toEqual([
      {
        action: "establishment.create",
        actor_user_id: result.userId,
        target_type: "location",
        target_id: String(result.locationId),
      },
    ]);
  });

  it("rejects an e-mail already in use, whatever its casing", async () => {
    await createEstablishment(input());

    await expect(
      createEstablishment(input({ email: "ALICE@Comptoir.test", establishmentName: "Le Bistrot" })),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("leaves no half-created customer behind when the e-mail is taken", async () => {
    await createEstablishment(input());

    await expect(
      createEstablishment(input({ email: "alice@comptoir.test", establishmentName: "Le Bistrot" })),
    ).rejects.toBeInstanceOf(ConflictError);

    // The organization and location are inserted *before* the users row that
    // fails, so this is the case the single transaction exists for: an
    // orphan organization would be a tenant nobody can ever log into, and
    // only a SQL console could clean it up.
    const { rows } = await pool.query("SELECT COUNT(*)::INT AS count FROM organizations");
    expect(rows[0].count).toBe(1);
    const { rows: locationRows } = await pool.query("SELECT COUNT(*)::INT AS count FROM locations");
    expect(locationRows[0].count).toBe(1);
  });

  it("writes nothing at all when the password is too weak", async () => {
    await expect(createEstablishment(input({ password: "court" }))).rejects.toBeInstanceOf(
      ValidationError,
    );

    const { rows } = await pool.query("SELECT COUNT(*)::INT AS count FROM organizations");
    expect(rows[0].count).toBe(0);
    const { rows: userRows } = await pool.query("SELECT COUNT(*)::INT AS count FROM users");
    expect(userRows[0].count).toBe(0);
  });

  it("isolates two establishments signing up independently", async () => {
    const first = await createEstablishment(input());
    const second = await createEstablishment(
      input({ establishmentName: "Le Bistrot", email: "bob@bistrot.test", ownerName: "Bob Roux" }),
    );

    expect(second.organizationId).not.toBe(first.organizationId);
    expect(second.locationId).not.toBe(first.locationId);

    // Each owner's session resolves to their own location only — the tenant
    // boundary every repository filters on (DEC-03).
    const firstSession = await findAuthenticatedSession(pool, first.token);
    const secondSession = await findAuthenticatedSession(pool, second.token);
    expect(firstSession?.locationId).toBe(first.locationId);
    expect(secondSession?.locationId).toBe(second.locationId);

    const { rows } = await pool.query(
      "SELECT COUNT(*)::INT AS count FROM memberships WHERE location_id = $1",
      [second.locationId],
    );
    expect(rows[0].count).toBe(1);
  });
});
