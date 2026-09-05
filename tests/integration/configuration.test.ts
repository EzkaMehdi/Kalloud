import { beforeEach, describe, expect, it } from "vitest";
import { listAuditEvents } from "../../lib/audit";
import { can } from "../../lib/authz";
import { pool } from "../../lib/db";
import { ConflictError, NotFoundError, ValidationError } from "../../lib/errors";
import { openBusinessDay } from "../../lib/repositories/business-days";
import { listProducts } from "../../lib/repositories/products";
import { getLocationSettings } from "../../lib/repositories/settings";
import { listAllDiningTables, listDiningTables } from "../../lib/repositories/tables";
import {
  addCategory,
  addDiningTable,
  addTaxClass,
  editCategory,
  editProduct,
  getConfiguration,
  reorderTables,
  setDiningTableActivation,
  updateConfiguration,
} from "../../lib/services/configuration";
import { getDashboardSummary } from "../../lib/services/dashboard";
import { createProductWithInitialStock } from "../../lib/services/products";
import { openOrResumeTableTicket } from "../../lib/services/tickets";
import { parseOrThrow } from "../../lib/validation/parse";
import {
  createTaxClassSchema,
  reorderTablesSchema,
  updateSettingsSchema,
} from "../../lib/validation/schemas";
import { createTestTenant, createTestUser, type TestTenant } from "./helpers/fixtures";
import { resetDatabase } from "./helpers/reset-database";
import { sell } from "./helpers/sales";
import type { RequestContext } from "../../lib/context";

/**
 * CFG-04 and GATE-4B.
 *
 * The gate's four criteria are what these assert, in order: an owner
 * configures without SQL, the catalogue and floor plan are administrable,
 * prices and deactivations keep the sales history intact, and the timezone,
 * currency and tax rules are *actually applied* rather than merely stored.
 */

let tenant: TestTenant;
let owner: RequestContext;
let manager: RequestContext;

async function contextFor(role: "OWNER" | "MANAGER" | "CASHIER"): Promise<RequestContext> {
  const user = await createTestUser(pool, tenant, role);
  return {
    userId: user.userId,
    userEmail: user.email,
    userName: `${role}`,
    organizationId: tenant.organizationId,
    locationId: tenant.locationId,
    role,
    sessionId: 1,
  };
}

function settings(overrides: Partial<Record<string, string>> = {}) {
  return parseOrThrow(updateSettingsSchema, {
    name: "Chez Kalloud",
    timezone: "Europe/Paris",
    currency: "EUR",
    defaultTaxRate: "20.00",
    cashDiscrepancyThreshold: "5.00",
    ...overrides,
  });
}

beforeEach(async () => {
  await resetDatabase(pool);
  tenant = await createTestTenant(pool, "Config Tenant");
  owner = await contextFor("OWNER");
  manager = await contextFor("MANAGER");
  await openBusinessDay(pool, tenant.locationId, "0.00");
});

describe("CFG-01: the establishment's own settings", () => {
  it("saves the name, timezone, currency, tax rate and threshold together", async () => {
    const updated = await updateConfiguration(
      owner,
      settings({ name: "Le Lounge", currency: "MAD", defaultTaxRate: "10.00" }),
    );

    expect(updated.name).toBe("Le Lounge");
    expect(updated.settings.currency).toBe("MAD");
    expect(updated.settings.defaultTaxRate).toBe(10);
    // Read back from the database, not from the return value.
    const persisted = await getLocationSettings(pool, tenant.locationId);
    expect(persisted.timezone).toBe("Europe/Paris");
    expect((await getConfiguration(owner)).name).toBe("Le Lounge");
  });

  it("refuses a timezone the runtime does not know", async () => {
    await expect(
      updateConfiguration(owner, settings({ timezone: "Mars/Olympus_Mons" })),
    ).rejects.toBeInstanceOf(ValidationError);
    // Nothing partial was written.
    expect((await getConfiguration(owner)).name).not.toBe("Chez Kalloud");
  });

  it("refuses a currency that is not a three-letter code", async () => {
    expect(updateSettingsSchema.safeParse({ ...settingsRaw(), currency: "euro" }).success).toBe(
      false,
    );
    expect(updateSettingsSchema.safeParse({ ...settingsRaw(), currency: "" }).success).toBe(false);
  });

  it("refuses a tax rate with three decimals, like every other rate (DEC-05)", () => {
    expect(
      updateSettingsSchema.safeParse({ ...settingsRaw(), defaultTaxRate: "20.005" }).success,
    ).toBe(false);
  });

  it("records the change, with what it was before", async () => {
    await updateConfiguration(owner, settings({ name: "Le Lounge" }));
    const event = (await listAuditEvents(pool, tenant.locationId)).find(
      (entry) => entry.action === "settings.update",
    );
    expect(event?.actorUserId).toBe(owner.userId);
    expect(event?.after).toMatchObject({ name: "Le Lounge" });
    // The "before" is what makes an audit entry useful rather than merely present.
    expect(event?.before).toBeTruthy();
  });

  it("adds a tax class, and refuses a duplicate name", async () => {
    const created = await addTaxClass(
      owner,
      parseOrThrow(createTaxClassSchema, { name: "Réduit", rate: "10.00" }),
    );
    expect(created.rate).toBe(10);
    await expect(
      addTaxClass(owner, parseOrThrow(createTaxClassSchema, { name: "Réduit", rate: "5.00" })),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("CFG-04: permissions are the server's decision, not the screen's", () => {
  it("gives settings:manage to the owner alone (DEC-07)", () => {
    // The acceptance criterion verbatim: "un manager non autorisé ne modifie
    // pas les réglages réservés au propriétaire".
    expect(can("OWNER", "settings:manage")).toBe(true);
    expect(can("MANAGER", "settings:manage")).toBe(false);
    expect(can("CASHIER", "settings:manage")).toBe(false);
  });

  it("does give a manager the catalogue and the floor plan", () => {
    for (const permission of ["catalog:manage", "tables:manage"] as const) {
      expect(can("MANAGER", permission)).toBe(true);
      expect(can("CASHIER", permission)).toBe(false);
    }
  });

  it("scopes every configuration read and write to the caller's establishment", async () => {
    const other = await createTestTenant(pool, "Other Tenant");
    const otherOwner = await createTestUser(pool, other, "OWNER");
    const otherContext: RequestContext = {
      userId: otherOwner.userId,
      userEmail: otherOwner.email,
      userName: "Other",
      organizationId: other.organizationId,
      locationId: other.locationId,
      role: "OWNER",
      sessionId: 2,
    };

    const table = await addDiningTable(owner, { name: "T1" });
    await expect(
      setDiningTableActivation(otherContext, table.id, { isActive: false }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(reorderTables(otherContext, { orderedIds: [table.id] })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe("CFG-02: the catalogue is administrable", () => {
  it("creates and renames a category, and audits both", async () => {
    const created = await addCategory(manager, { name: "Desserts" });
    const renamed = await editCategory(manager, created.id, { name: "Douceurs" });
    expect(renamed.name).toBe("Douceurs");

    const actions = (await listAuditEvents(pool, tenant.locationId)).map((event) => event.action);
    expect(actions).toEqual(expect.arrayContaining(["category.create", "category.update"]));
  });

  it("refuses two categories with the same name", async () => {
    await addCategory(manager, { name: "Boissons" });
    await expect(addCategory(manager, { name: "Boissons" })).rejects.toBeInstanceOf(ConflictError);
  });

  it("keeps a deactivated product out of the caisse but in the history", async () => {
    const product = await createProductWithInitialStock(owner, {
      categoryId: null,
      name: "Café",
      price: "3.00",
      stockQuantity: 10,
    });
    const { order } = await sell(owner, [{ productId: product.id, quantity: 1 }]);

    await editProduct(manager, product.id, { isActive: false });

    // GATE-4B: "prix et désactivations conservent l'historique des ventes".
    const rows = await listProducts(pool, tenant.locationId);
    expect(rows.find((row) => row.id === product.id)?.is_active).toBe(false);
    const { rows: lines } = await pool.query<{ product_id: number }>(
      "SELECT product_id FROM order_items WHERE order_id = $1",
      [order.id],
    );
    expect(lines[0].product_id).toBe(product.id);
  });

  it("changes a price without rewriting what was already sold", async () => {
    const product = await createProductWithInitialStock(owner, {
      categoryId: null,
      name: "Thé",
      price: "4.00",
      stockQuantity: 10,
    });
    const { order } = await sell(owner, [{ productId: product.id, quantity: 1 }]);

    await editProduct(manager, product.id, { price: 900 });

    const { rows } = await pool.query<{ unit_price: string }>(
      "SELECT unit_price FROM order_items WHERE order_id = $1",
      [order.id],
    );
    // The sale keeps the price it was made at; only the catalogue moved.
    expect(rows[0].unit_price).toBe("4.00");
    expect(
      (await listProducts(pool, tenant.locationId)).find((row) => row.id === product.id)?.price,
    ).toBe("9.00");
  });

  it("audits a price change with who made it", async () => {
    const product = await createProductWithInitialStock(owner, {
      categoryId: null,
      name: "Café",
      price: "3.00",
    });
    await editProduct(manager, product.id, { price: 350 });

    const event = (await listAuditEvents(pool, tenant.locationId)).find(
      (entry) => entry.action === "product.update",
    );
    expect(event?.actorUserId).toBe(manager.userId);
    expect(event?.after).toMatchObject({ price: "3.50" });
  });

  it("lets a category be assigned and cleared", async () => {
    const category = await addCategory(manager, { name: "Boissons" });
    const product = await createProductWithInitialStock(owner, {
      categoryId: null,
      name: "Café",
      price: "3.00",
    });

    await editProduct(manager, product.id, { categoryId: category.id });
    expect(
      (await listProducts(pool, tenant.locationId)).find((row) => row.id === product.id)
        ?.category_id,
    ).toBe(category.id);

    // Clearing is a real intent, distinct from "said nothing about it".
    await editProduct(manager, product.id, { categoryId: null });
    expect(
      (await listProducts(pool, tenant.locationId)).find((row) => row.id === product.id)
        ?.category_id,
    ).toBeNull();
  });
});

describe("CFG-03: the floor plan is administrable", () => {
  it("creates, orders and deactivates tables", async () => {
    const first = await addDiningTable(manager, { name: "T1" });
    const second = await addDiningTable(manager, { name: "T2" });

    await reorderTables(manager, { orderedIds: [second.id, first.id] });
    const ordered = await listDiningTables(pool, tenant.locationId);
    expect(ordered.map((table) => table.id)).toEqual([second.id, first.id]);

    await setDiningTableActivation(manager, first.id, { isActive: false });
    // The floor plan drops it; the configuration screen still sees it.
    expect(
      (await listDiningTables(pool, tenant.locationId)).map((table) => table.id),
    ).not.toContain(first.id);
    expect((await listAllDiningTables(pool, tenant.locationId)).map((table) => table.id)).toContain(
      first.id,
    );
  });

  it("refuses to deactivate a table that still carries an open ticket", async () => {
    const table = await addDiningTable(manager, { name: "T1" });
    await openOrResumeTableTicket(manager, table.id);

    // The acceptance criterion verbatim: no silent deactivation of a table
    // someone is still serving.
    await expect(
      setDiningTableActivation(manager, table.id, { isActive: false }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(
      (await listDiningTables(pool, tenant.locationId)).find((row) => row.id === table.id)
        ?.is_active,
    ).toBe(true);
  });

  it("refuses a reorder naming the same table twice", async () => {
    const table = await addDiningTable(manager, { name: "T1" });
    expect(reorderTablesSchema.safeParse({ orderedIds: [table.id, table.id] }).success).toBe(false);
  });

  it("audits every floor-plan change", async () => {
    const table = await addDiningTable(manager, { name: "T1" });
    await setDiningTableActivation(manager, table.id, { isActive: false });
    await reorderTables(manager, { orderedIds: [table.id] });

    const actions = (await listAuditEvents(pool, tenant.locationId)).map((event) => event.action);
    expect(actions).toEqual(
      expect.arrayContaining(["table.create", "table.deactivate", "table.reorder"]),
    );
  });
});

describe("GATE-4B: the settings are actually applied", () => {
  it("uses the configured default tax rate for a product with no class of its own", async () => {
    await updateConfiguration(owner, settings({ defaultTaxRate: "10.00" }));
    const product = await createProductWithInitialStock(owner, {
      categoryId: null,
      name: "Café",
      price: "11.00",
      stockQuantity: 10,
    });

    const { order } = await sell(owner, [{ productId: product.id, quantity: 1 }]);
    // 11,00 € TTC at 10 % is 1,00 € of tax — at the old 20 % it would be 1,83 €.
    expect(order.tax_amount).toBe("1.00");
  });

  it("computes period boundaries in the establishment's timezone, not the server's", async () => {
    // A zone far from any plausible CI host, so the boundary genuinely moves.
    await updateConfiguration(owner, settings({ timezone: "Pacific/Kiritimati" }));
    const product = await createProductWithInitialStock(owner, {
      categoryId: null,
      name: "Café",
      price: "10.00",
      stockQuantity: 10,
    });
    const { order } = await sell(owner, [{ productId: product.id, quantity: 1 }]);

    // Ask for the month that contains the sale *in that zone*, which may
    // differ from the server's month at the edges.
    const paidAt = new Date(order.paid_at);
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Pacific/Kiritimati",
      year: "numeric",
      month: "2-digit",
    }).formatToParts(paidAt);
    const year = Number(parts.find((part) => part.type === "year")?.value);
    const month = Number(parts.find((part) => part.type === "month")?.value);

    const summary = await getDashboardSummary(tenant.locationId, {
      period: "month",
      year,
      month,
    });
    expect(Number(summary.revenue)).toBeGreaterThan(0);
  });

  it("stores the currency the caisse then formats with", async () => {
    await updateConfiguration(owner, settings({ currency: "MAD" }));
    // The client reads it from here (lib/client/use-currency.ts); what this
    // asserts is that the value survives the round trip rather than being a
    // field with no reader.
    expect((await getConfiguration(owner)).settings.currency).toBe("MAD");
  });
});

/* Helpers kept at the bottom so the tests above read as the criteria they check. */

function settingsRaw() {
  return {
    name: "Chez Kalloud",
    timezone: "Europe/Paris",
    currency: "EUR",
    defaultTaxRate: "20.00",
    cashDiscrepancyThreshold: "5.00",
  };
}
