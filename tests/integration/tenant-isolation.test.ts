import { beforeEach, describe, expect, it } from "vitest";
import { pool } from "../../lib/db";
import { NotFoundError, ValidationError } from "../../lib/errors";
import { recordAuditEvent, listAuditEvents } from "../../lib/audit";
import { listCategories } from "../../lib/repositories/categories";
import {
  createProduct,
  listProducts,
  lockProductsForSale,
  overwriteProductStockQuantity,
  updateProduct,
} from "../../lib/repositories/products";
import {
  createDiningTable,
  listDiningTables,
  renameDiningTable,
} from "../../lib/repositories/tables";
import {
  closeBusinessDay,
  getActiveBusinessDay,
  getBusinessDaySummary,
  openBusinessDay,
} from "../../lib/repositories/business-days";
import { createCashMovement, listCashMovements } from "../../lib/repositories/cash-movements";
import { getLocationSettings, listTaxClasses } from "../../lib/repositories/settings";
import { listOrders } from "../../lib/repositories/orders";
import { performCheckout } from "../../lib/services/checkout";
import {
  openDirectSaleTicket,
  openOrResumeTableTicket,
  saveTicketItems,
} from "../../lib/services/tickets";
import { createTestTenant, createTestUser, type TestTenant } from "./helpers/fixtures";
import { resetDatabase } from "./helpers/reset-database";
import type { RequestContext } from "../../lib/context";

/**
 * SEC-08: every read must be invisible across organizations, and every
 * write/mutation attempted with another tenant's id must fail exactly as if
 * the row did not exist (NotFoundError), never succeed and never leak which
 * ids belong to someone else. Runs at the repository/service layer directly
 * (rather than importing app/api/**\/route.ts handlers) because Next's
 * `cookies()` throws "called outside a request scope" when a Route Handler
 * is invoked outside Next's own server dispatch — confirmed while writing
 * this suite. The HTTP+session+RBAC layer itself is exercised by the
 * Playwright E2E suite (tests/e2e/*.spec.ts), which runs against a real
 * server.
 */

let tenantA: TestTenant;
let tenantB: TestTenant;
let contextA: RequestContext;

beforeEach(async () => {
  await resetDatabase(pool);
  tenantA = await createTestTenant(pool, "Tenant A");
  tenantB = await createTestTenant(pool, "Tenant B");
  const ownerA = await createTestUser(pool, tenantA, "OWNER");
  contextA = {
    userId: ownerA.userId,
    userEmail: ownerA.email,
    userName: "Owner A",
    organizationId: tenantA.organizationId,
    locationId: tenantA.locationId,
    role: "OWNER",
    sessionId: 0,
  };
});

describe("SEC-08: catalog isolation", () => {
  it("never lists another tenant's categories or products", async () => {
    await pool.query(
      "INSERT INTO categories (location_id, name) VALUES ($1, 'Tenant A Category')",
      [tenantA.locationId],
    );
    await pool.query(
      "INSERT INTO categories (location_id, name) VALUES ($1, 'Tenant B Category')",
      [tenantB.locationId],
    );
    const productB = await createProduct(pool, tenantB.locationId, {
      categoryId: null,
      name: "Tenant B Secret Product",
      price: "42.00",
    });

    const categoriesA = await listCategories(pool, tenantA.locationId);
    expect(categoriesA.map((c) => c.name)).toEqual(["Tenant A Category"]);

    const productsA = await listProducts(pool, tenantA.locationId);
    expect(productsA.find((p) => p.id === productB.id)).toBeUndefined();
  });

  it("refuses to update a product belonging to another tenant (404, not a silent no-op)", async () => {
    const productB = await createProduct(pool, tenantB.locationId, {
      categoryId: null,
      name: "Tenant B Product",
      price: "10.00",
    });

    await expect(
      updateProduct(pool, tenantA.locationId, productB.id, { name: "Renamed by attacker" }),
    ).rejects.toBeInstanceOf(NotFoundError);

    const untouched = await listProducts(pool, tenantB.locationId);
    expect(untouched.find((p) => p.id === productB.id)?.name).toBe("Tenant B Product");
  });

  it("refuses a cross-tenant absolute stock write", async () => {
    const productB = await createProduct(pool, tenantB.locationId, {
      categoryId: null,
      name: "Tenant B Stock Target",
      price: "10.00",
      stockQuantity: 5,
    });

    await expect(
      overwriteProductStockQuantity(pool, tenantA.locationId, productB.id, 9999),
    ).rejects.toBeInstanceOf(NotFoundError);

    const untouched = await listProducts(pool, tenantB.locationId);
    expect(untouched.find((p) => p.id === productB.id)?.stock_quantity).toBe(5);
  });

  it("cannot lock another tenant's product for a sale (the row simply is not visible)", async () => {
    const productB = await createProduct(pool, tenantB.locationId, {
      categoryId: null,
      name: "Tenant B Checkout Target",
      price: "10.00",
      stockQuantity: 5,
    });

    const locked = await lockProductsForSale(pool, tenantA.locationId, [productB.id]);
    expect(locked).toHaveLength(0);
  });
});

describe("SEC-08: floor plan isolation", () => {
  it("never lists another tenant's tables", async () => {
    await createDiningTable(pool, tenantA.locationId, "A1");
    const tableB = await createDiningTable(pool, tenantB.locationId, "B1");

    const tablesA = await listDiningTables(pool, tenantA.locationId);
    expect(tablesA.find((t) => t.id === tableB.id)).toBeUndefined();
  });

  it("refuses to rename another tenant's table", async () => {
    // ORD-03 removed the stored FREE/OCCUPIED status, so renaming is the
    // only mutation a table still has; occupancy is derived from its open
    // ticket, and the cross-tenant case for that is covered below.
    const tableB = await createDiningTable(pool, tenantB.locationId, "B1");

    await expect(
      renameDiningTable(pool, tenantA.locationId, tableB.id, "Stolen"),
    ).rejects.toBeInstanceOf(NotFoundError);

    const [row] = await listDiningTables(pool, tenantB.locationId);
    expect(row.name).toBe("B1");
    expect(row.is_occupied).toBe(false);
  });

  it("never reports a table as occupied because of another tenant's ticket", async () => {
    const tableA = await createDiningTable(pool, tenantA.locationId, "A1");
    const tableB = await createDiningTable(pool, tenantB.locationId, "B1");
    await openBusinessDay(pool, tenantB.locationId, "100.00");
    const ownerB = await createTestUser(pool, tenantB, "OWNER");
    await openOrResumeTableTicket(
      {
        userId: ownerB.userId,
        userEmail: ownerB.email,
        userName: "Owner B",
        organizationId: tenantB.organizationId,
        locationId: tenantB.locationId,
        role: "OWNER",
        sessionId: 1,
      },
      tableB.id,
    );

    const tablesA = await listDiningTables(pool, tenantA.locationId);
    expect(tablesA.find((row) => row.id === tableA.id)?.is_occupied).toBe(false);
    const tablesB = await listDiningTables(pool, tenantB.locationId);
    expect(tablesB.find((row) => row.id === tableB.id)?.is_occupied).toBe(true);
  });
});

describe("SEC-08: cash and business-day isolation", () => {
  it("getActiveBusinessDay never crosses tenants", async () => {
    const dayA = await openBusinessDay(pool, tenantA.locationId, "100.00");
    const dayB = await openBusinessDay(pool, tenantB.locationId, "200.00");

    const activeForA = await getActiveBusinessDay(pool, tenantA.locationId);
    expect(activeForA?.id).toBe(dayA.id);
    expect(activeForA?.id).not.toBe(dayB.id);
  });

  it("refuses to close another tenant's business day", async () => {
    const dayB = await openBusinessDay(pool, tenantB.locationId, "200.00");

    await expect(
      closeBusinessDay(pool, tenantA.locationId, dayB.id, "500.00"),
    ).rejects.toBeInstanceOf(NotFoundError);

    const stillOpen = await getActiveBusinessDay(pool, tenantB.locationId);
    expect(stillOpen?.id).toBe(dayB.id);
    expect(stillOpen?.status).toBe("OPEN");
  });

  it("business day summaries and cash movements never mix tenants", async () => {
    const ownerB = await createTestUser(pool, tenantB, "OWNER");
    const dayA = await openBusinessDay(pool, tenantA.locationId, "100.00");
    const dayB = await openBusinessDay(pool, tenantB.locationId, "200.00");

    await createCashMovement(pool, tenantA.locationId, {
      businessDayId: dayA.id,
      type: "IN",
      amount: "10.00",
      reason: "A movement",
      createdBy: contextA.userId,
    });
    await createCashMovement(pool, tenantB.locationId, {
      businessDayId: dayB.id,
      type: "IN",
      amount: "999.00",
      reason: "B movement",
      createdBy: ownerB.userId,
    });

    const movementsA = await listCashMovements(pool, tenantA.locationId);
    expect(movementsA).toHaveLength(1);
    expect(movementsA[0].reason).toBe("A movement");

    const summaryA = await getBusinessDaySummary(pool, tenantA.locationId, dayA.id);
    expect(Number(summaryA.revenue)).toBe(0);

    // Attempting to read tenant B's day through tenant A's location scope
    // finds nothing (COALESCE keeps the aggregate defined but empty), it
    // never accidentally aggregates tenant B's numbers into tenant A's report.
    const crossSummary = await getBusinessDaySummary(pool, tenantA.locationId, dayB.id);
    expect(Number(crossSummary.orders_count)).toBe(0);
  });
});

describe("SEC-08: settings isolation", () => {
  it("location settings and tax classes never cross tenants", async () => {
    await pool.query("UPDATE location_settings SET currency = 'USD' WHERE location_id = $1", [
      tenantA.locationId,
    ]);
    await pool.query("UPDATE location_settings SET currency = 'EUR' WHERE location_id = $1", [
      tenantB.locationId,
    ]);
    await pool.query(
      "INSERT INTO tax_classes (location_id, name, rate, is_default) VALUES ($1, 'Tenant A Rate', 15, true)",
      [tenantA.locationId],
    );

    const settingsA = await getLocationSettings(pool, tenantA.locationId);
    const settingsB = await getLocationSettings(pool, tenantB.locationId);
    expect(settingsA.currency).toBe("USD");
    expect(settingsB.currency).toBe("EUR");

    const taxClassesB = await listTaxClasses(pool, tenantB.locationId);
    expect(taxClassesB.find((t) => t.name === "Tenant A Rate")).toBeUndefined();
  });
});

describe("SEC-08: audit log isolation", () => {
  it("never exposes another tenant's audit events", async () => {
    await recordAuditEvent(pool, {
      locationId: tenantA.locationId,
      actorUserId: contextA.userId,
      action: "test.tenant_a_secret_action",
      targetType: "test",
      targetId: 1,
    });

    const eventsB = await listAuditEvents(pool, tenantB.locationId);
    expect(eventsB.find((event) => event.action === "test.tenant_a_secret_action")).toBeUndefined();
  });
});

describe("SEC-08: checkout cannot reach across tenants", () => {
  it("refuses to pay another tenant's ticket as if it did not exist", async () => {
    // ORD-07 made every sale name the ticket it settles, so this — not a
    // product id in a request body — is now the way a checkout could reach
    // across establishments.
    await openBusinessDay(pool, tenantB.locationId, "100.00");
    const productB = await createProduct(pool, tenantB.locationId, {
      categoryId: null,
      name: "Tenant B Product",
      price: "10.00",
      stockQuantity: 5,
    });
    const ownerB = await createTestUser(pool, tenantB, "OWNER");
    const contextB: RequestContext = {
      userId: ownerB.userId,
      userEmail: ownerB.email,
      userName: "Owner B",
      organizationId: tenantB.organizationId,
      locationId: tenantB.locationId,
      role: "OWNER",
      sessionId: 2,
    };
    const ticketB = await openDirectSaleTicket(contextB);
    await saveTicketItems(contextB, ticketB.id, {
      version: ticketB.version,
      items: [{ productId: productB.id, quantity: 1 }],
    });

    await expect(
      performCheckout(contextA, {
        orderId: ticketB.id,
        paymentMethod: "CARD",
        cashAmountCents: 0,
        cardAmountCents: 1000,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);

    // B's ticket is untouched: still open, still unsold.
    const productsB = await listProducts(pool, tenantB.locationId);
    expect(productsB.find((p) => p.id === productB.id)?.stock_quantity).toBe(5);
    expect(await listOrders(pool, tenantA.locationId)).toHaveLength(0);
    expect(await listOrders(pool, tenantB.locationId)).toHaveLength(0);
  });

  it("still lets tenant A sell its own product normally (isolation is not over-blocking)", async () => {
    await openBusinessDay(pool, tenantA.locationId, "100.00");
    const productA = await createProduct(pool, tenantA.locationId, {
      categoryId: null,
      name: "Tenant A Product",
      price: "10.00",
      stockQuantity: 5,
    });

    const ticket = await openDirectSaleTicket(contextA);
    await saveTicketItems(contextA, ticket.id, {
      version: ticket.version,
      items: [{ productId: productA.id, quantity: 2 }],
    });
    const result = await performCheckout(contextA, {
      orderId: ticket.id,
      paymentMethod: "CARD",
      cashAmountCents: 0,
      cardAmountCents: 2000,
    });

    expect(result.total).toBe(20);
    const productsA = await listProducts(pool, tenantA.locationId);
    expect(productsA.find((p) => p.id === productA.id)?.stock_quantity).toBe(3);
  });

  it("refuses to open a ticket on another tenant's business day", async () => {
    // Tenant B has an open day, tenant A does not — a bug resolving "the"
    // active business day globally instead of per establishment would let
    // tenant A start selling on B's service.
    await openBusinessDay(pool, tenantB.locationId, "100.00");

    await expect(openDirectSaleTicket(contextA)).rejects.toBeInstanceOf(ValidationError);
  });
});
