import { beforeEach, describe, expect, it } from "vitest";
import { login } from "../../lib/auth/service";
import { createSession, findAuthenticatedSession } from "../../lib/auth/session";
import { pool, withTransaction } from "../../lib/db";
import { UnauthenticatedError } from "../../lib/errors";
import { openNewBusinessDay } from "../../lib/services/business-day";
import { createProductWithInitialStock } from "../../lib/services/products";
import {
  ANONYMIZED_NAME,
  anonymizeUser,
  anonymizedEmailFor,
  exportEstablishmentArchive,
  getRetentionStatus,
  purgeEstablishment,
  RETENTION_YEARS,
  // @ts-expect-error -- plain JS module shared with the CLI scripts, same precedent as tests/unit/backup-retention.test.ts
} from "../../scripts/lib/retention-core.mjs";
import { createTestTenant, createTestUser, type TestTenant } from "./helpers/fixtures";
import { resetDatabase } from "./helpers/reset-database";
import { sell } from "./helpers/sales";
import type { RequestContext } from "../../lib/context";

/**
 * OPS-04's acceptance criterion: "comportement documenté et testé sans
 * casser les obligations comptables retenues."
 *
 * The second half is what most of these assert. Honouring a deletion
 * request is easy on its own; doing it while a six-year accounting trail
 * keeps pointing at the person is the whole problem, and the answer — the
 * `users` row survives, anonymised — is only correct if the ledger really
 * does still read afterwards.
 */

let tenant: TestTenant;
let owner: RequestContext;
let ownerPassword: string;
let ownerEmail: string;

async function contextFor(role: "OWNER" | "MANAGER" | "CASHIER") {
  const user = await createTestUser(pool, tenant, role);
  const context: RequestContext = {
    userId: user.userId,
    userEmail: user.email,
    userName: role,
    organizationId: tenant.organizationId,
    locationId: tenant.locationId,
    role,
    sessionId: 1,
  };
  return { context, user };
}

/** A complete day of trading: a sale, its payment, stock movements, a cash journal. */
async function tradeOneDay(context: RequestContext) {
  // Through the service, so the opening float is written to the cash
  // journal too (CASH-01/CASH-03) — the ledger this ticket must not break.
  await openNewBusinessDay(context, 10_000);
  const product = await createProductWithInitialStock(context, {
    categoryId: null,
    name: "Café",
    price: "2.50",
    stockQuantity: 20,
  });
  return sell(context, [{ productId: product.id, quantity: 2 }], { paymentMethod: "CASH" });
}

/** Moves every dated accounting row out of the retention window. */
async function backdateEverything(locationId: number, years: number) {
  const shift = `${years} years`;
  for (const [table, column] of [
    ["orders", "created_at"],
    ["payments", "created_at"],
    ["cash_movements", "created_at"],
    ["stock_movements", "created_at"],
    ["business_days", "opened_at"],
    ["audit_events", "created_at"],
  ]) {
    await pool.query(
      `UPDATE ${table} SET ${column} = ${column} - INTERVAL '${shift}' WHERE location_id = $1`,
      [locationId],
    );
  }
}

beforeEach(async () => {
  await resetDatabase(pool);
  tenant = await createTestTenant(pool);
  const created = await contextFor("OWNER");
  owner = created.context;
  ownerEmail = created.user.email;
  ownerPassword = created.user.password;
});

describe("retention policy (OPS-04/DEC-10)", () => {
  it("protects everything a fresh establishment has just recorded", async () => {
    await tradeOneDay(owner);

    const status = await getRetentionStatus(pool, tenant.locationId);
    expect(status.retentionYears).toBe(RETENTION_YEARS);
    expect(status.totalProtectedRows).toBeGreaterThan(0);
    expect(status.purgeAllowed).toBe(false);
    // The date is computed from the newest record, so an operator can tell
    // a customer when their request becomes possible instead of "later".
    expect(status.purgeAllowedFrom).toBeTruthy();
  });

  it("stops protecting records once the six years have run out", async () => {
    await tradeOneDay(owner);
    await backdateEverything(tenant.locationId, RETENTION_YEARS + 1);

    const status = await getRetentionStatus(pool, tenant.locationId);
    expect(status.totalProtectedRows).toBe(0);
    expect(status.purgeAllowed).toBe(true);
  });
});

describe("anonymisation (OPS-04/DEC-10)", () => {
  it("erases the person and keeps the accounting trail readable", async () => {
    const cashier = await contextFor("CASHIER");
    await openNewBusinessDay(owner, 10_000);
    const product = await createProductWithInitialStock(owner, {
      categoryId: null,
      name: "Café",
      price: "2.50",
      stockQuantity: 20,
    });
    const sale = await sell(cashier.context, [{ productId: product.id, quantity: 2 }], {
      paymentMethod: "CASH",
    });

    await withTransaction((client) => anonymizeUser(client, cashier.user.userId));

    const { rows: users } = await pool.query<{ name: string; email: string; status: string }>(
      "SELECT name, email, status FROM users WHERE id = $1",
      [cashier.user.userId],
    );
    expect(users[0]).toEqual({
      name: ANONYMIZED_NAME,
      email: anonymizedEmailFor(cashier.user.userId),
      status: "DISABLED",
    });

    // The point of the whole design: the sale is still there, still
    // attributed, still joinable. A deletion that broke this would satisfy
    // the person and break an obligation neither party can waive.
    const { rows: ledger } = await pool.query<{ total: string; author: string }>(
      `SELECT o.total_amount::TEXT AS total, u.name AS author
         FROM orders o JOIN users u ON u.id = o.created_by
        WHERE o.id = $1`,
      [sale.order.id],
    );
    expect(ledger).toHaveLength(1);
    expect(ledger[0].total).toBe("5.00");
    expect(ledger[0].author).toBe(ANONYMIZED_NAME);

    for (const table of ["payments", "stock_movements", "cash_movements"]) {
      const { rows } = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::TEXT AS count FROM ${table} WHERE location_id = $1`,
        [tenant.locationId],
      );
      expect(Number(rows[0].count), `${table} must survive an anonymisation`).toBeGreaterThan(0);
    }
  });

  it("locks the account out, session and password alike", async () => {
    const cashier = await contextFor("CASHIER");
    const opened = await createSession(pool, cashier.user.userId, {});
    expect(await findAuthenticatedSession(pool, opened.token)).not.toBeNull();

    await withTransaction((client) => anonymizeUser(client, cashier.user.userId));

    expect(await findAuthenticatedSession(pool, opened.token)).toBeNull();
    await expect(
      login({
        email: cashier.user.email,
        password: cashier.user.password,
        ipAddress: null,
        userAgent: null,
      }),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it("never writes the erased address into the audit log", async () => {
    const cashier = await contextFor("CASHIER");
    await withTransaction((client) => anonymizeUser(client, cashier.user.userId));

    const { rows } = await pool.query<{ action: string; target_id: string; after_data: unknown }>(
      "SELECT action, target_id, after_data FROM audit_events WHERE action = 'user.anonymize'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].target_id).toBe(String(cashier.user.userId));
    // Recording the old address would keep the very identifier the request
    // asked to erase, in a table nothing is allowed to delete from.
    expect(JSON.stringify(rows[0].after_data)).not.toContain(cashier.user.email);
  });

  it("removes the personal traces that carry no accounting value", async () => {
    const cashier = await contextFor("CASHIER");
    await pool.query(
      "INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, 'hash', now() + interval '1 hour')",
      [cashier.user.userId],
    );
    await pool.query(
      "INSERT INTO login_attempts (email, ip_address, succeeded) VALUES ($1, '127.0.0.1', false)",
      [cashier.user.email],
    );

    await withTransaction((client) => anonymizeUser(client, cashier.user.userId));

    const { rows: tokens } = await pool.query(
      "SELECT 1 FROM password_reset_tokens WHERE user_id = $1",
      [cashier.user.userId],
    );
    expect(tokens).toHaveLength(0);
    const { rows: attempts } = await pool.query("SELECT 1 FROM login_attempts WHERE email = $1", [
      cashier.user.email,
    ]);
    expect(attempts).toHaveLength(0);
  });

  it("refuses to anonymise an account twice", async () => {
    const cashier = await contextFor("CASHIER");
    await withTransaction((client) => anonymizeUser(client, cashier.user.userId));

    await expect(
      withTransaction((client) => anonymizeUser(client, cashier.user.userId)),
    ).rejects.toThrow(/déjà anonymisé/);
  });

  it("leaves the account untouched when the operation fails part-way", async () => {
    const cashier = await contextFor("CASHIER");

    await expect(
      withTransaction(async (client) => {
        await anonymizeUser(client, cashier.user.userId);
        throw new Error("interruption");
      }),
    ).rejects.toThrow("interruption");

    // A half-erased account — credentials revoked, name still readable — is
    // worse than one not yet processed.
    const { rows } = await pool.query<{ email: string; status: string }>(
      "SELECT email, status FROM users WHERE id = $1",
      [cashier.user.userId],
    );
    expect(rows[0].email).toBe(cashier.user.email);
    expect(rows[0].status).toBe("ACTIVE");
  });
});

describe("full purge (OPS-04/DEC-10)", () => {
  it("refuses without an explicit confirmation", async () => {
    await expect(
      withTransaction((client) => purgeEstablishment(client, tenant.locationId, {})),
    ).rejects.toThrow(/confirmation explicite/);
  });

  it("refuses while accounting obligations still apply", async () => {
    await tradeOneDay(owner);

    await expect(
      withTransaction((client) => purgeEstablishment(client, tenant.locationId, { confirm: true })),
    ).rejects.toThrow(/période de conservation/);

    const { rows } = await pool.query("SELECT 1 FROM locations WHERE id = $1", [tenant.locationId]);
    expect(rows).toHaveLength(1);
  });

  it("erases everything once nothing is left to keep", async () => {
    await tradeOneDay(owner);
    await backdateEverything(tenant.locationId, RETENTION_YEARS + 1);

    const result = (await withTransaction((client) =>
      purgeEstablishment(client, tenant.locationId, { confirm: true }),
    )) as { deleted: Record<string, number> };
    expect(result.deleted.orders).toBeGreaterThan(0);
    expect(result.deleted.locations).toBe(1);

    // Children first, or the foreign keys would have refused: nothing is
    // left pointing at a row that no longer exists.
    for (const table of [
      "orders",
      "payments",
      "stock_movements",
      "cash_movements",
      "business_days",
      "products",
      "memberships",
      "audit_events",
      "location_settings",
    ]) {
      const { rows } = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::TEXT AS count FROM ${table} WHERE location_id = $1`,
        [tenant.locationId],
      );
      expect(Number(rows[0].count), `${table} must be empty after a purge`).toBe(0);
    }
  });

  it("does not touch another establishment", async () => {
    const other = await createTestTenant(pool, "Voisin");
    await pool.query("INSERT INTO dining_tables (location_id, name) VALUES ($1, 'Terrasse')", [
      other.locationId,
    ]);
    await tradeOneDay(owner);
    await backdateEverything(tenant.locationId, RETENTION_YEARS + 1);

    await withTransaction((client) =>
      purgeEstablishment(client, tenant.locationId, { confirm: true }),
    );

    const { rows } = await pool.query("SELECT 1 FROM locations WHERE id = $1", [other.locationId]);
    expect(rows).toHaveLength(1);
  });
});

describe("export before deletion (OPS-04/DEC-10)", () => {
  it("hands back everything the establishment owns", async () => {
    const sale = await tradeOneDay(owner);

    const archive = await exportEstablishmentArchive(pool, tenant.locationId);
    expect(archive.orders.map((order: { id: number }) => order.id)).toContain(sale.order.id);
    expect(archive.payments.length).toBeGreaterThan(0);
    expect(archive.orderItems.length).toBeGreaterThan(0);
    expect(archive.stockMovements.length).toBeGreaterThan(0);
    expect(archive.cashMovements.length).toBeGreaterThan(0);
    expect(archive.businessDays.length).toBeGreaterThan(0);
    expect(archive.products.length).toBeGreaterThan(0);
    expect(archive.settings).not.toBeNull();
    // The member list is the customer's own record of who had access — the
    // thing an anonymisation is about to make unreadable.
    expect(archive.members.map((member: { email: string }) => member.email)).toContain(ownerEmail);
    // Carries the retention picture, so the archive explains on its own why
    // a purge was or was not possible at the time it was taken.
    expect(archive.retention.purgeAllowed).toBe(false);
  });

  it("belongs to one establishment only", async () => {
    const other = await createTestTenant(pool, "Voisin");
    await pool.query("INSERT INTO dining_tables (location_id, name) VALUES ($1, 'Terrasse')", [
      other.locationId,
    ]);
    await tradeOneDay(owner);

    const archive = await exportEstablishmentArchive(pool, tenant.locationId);
    expect(archive.tables.map((table: { name: string }) => table.name)).not.toContain("Terrasse");
  });
});

describe("the operator's own login still works after all this", () => {
  it("does not disturb accounts that were not part of the request", async () => {
    const cashier = await contextFor("CASHIER");
    await withTransaction((client) => anonymizeUser(client, cashier.user.userId));

    const session = await login({
      email: ownerEmail,
      password: ownerPassword,
      ipAddress: null,
      userAgent: null,
    });
    expect(session.token).toBeTruthy();
  });
});
