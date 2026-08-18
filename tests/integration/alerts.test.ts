import { beforeEach, describe, expect, it } from "vitest";
import { pool } from "../../lib/db";
import { closeBusinessDay, openBusinessDay } from "../../lib/repositories/business-days";
import { createCashMovement } from "../../lib/repositories/cash-movements";
import { createProduct } from "../../lib/repositories/products";
import { getAlerts } from "../../lib/services/alerts";
import { openDirectSaleTicket } from "../../lib/services/tickets";
import { createTestTenant, createTestUser, type TestTenant } from "./helpers/fixtures";
import { resetDatabase } from "./helpers/reset-database";
import type { RequestContext } from "../../lib/context";

/**
 * BI-06's acceptance criterion, verbatim: "maximum cinq alertes
 * prioritaires ; chacune ouvre l'action correspondante." The five types
 * are VISION_PRODUIT_ET_AUDIT.md §10's own list; each is proved to fire
 * only when its condition genuinely holds, and to stay silent otherwise —
 * an alert that fires unconditionally is not a signal.
 */

let tenant: TestTenant;
let context: RequestContext;

beforeEach(async () => {
  await resetDatabase(pool);
  tenant = await createTestTenant(pool, "Alerts Tenant");
  const owner = await createTestUser(pool, tenant, "OWNER");
  context = {
    userId: owner.userId,
    userEmail: owner.email,
    userName: "Owner",
    organizationId: tenant.organizationId,
    locationId: tenant.locationId,
    role: "OWNER",
    sessionId: 1,
  };
});

describe("BI-06: no alert fires for an establishment with nothing to report", () => {
  it("returns an empty list", async () => {
    const alerts = await getAlerts(context);
    expect(alerts).toEqual([]);
  });
});

describe("BI-06: rupture ou stock sous seuil", () => {
  it("fires as critical when a product is out of stock, naming the count and linking to /stock", async () => {
    await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "Rupture",
      price: "5.00",
      stockQuantity: 0,
    });

    const alerts = await getAlerts(context);

    const stockAlert = alerts.find((alert) => alert.type === "stock");
    expect(stockAlert).toBeDefined();
    expect(stockAlert?.severity).toBe("critical");
    expect(stockAlert?.message).toContain("1 en rupture");
    expect(stockAlert?.actionHref).toBe("/stock");
  });

  it("fires as a warning (not critical) when a product is only under threshold", async () => {
    await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "Sous seuil",
      price: "5.00",
      stockQuantity: 2,
      alertThreshold: 5,
    });

    const alerts = await getAlerts(context);

    const stockAlert = alerts.find((alert) => alert.type === "stock");
    expect(stockAlert?.severity).toBe("warning");
    expect(stockAlert?.message).toContain("1 sous le seuil");
  });

  it("stays silent for a product with healthy stock", async () => {
    await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "Stock confortable",
      price: "5.00",
      stockQuantity: 10,
      alertThreshold: 5,
    });

    expect((await getAlerts(context)).find((alert) => alert.type === "stock")).toBeUndefined();
  });
});

describe("BI-06: écart de caisse", () => {
  it("fires when the last closing's variance exceeds the establishment's own threshold (CFG-00)", async () => {
    await pool.query(
      "UPDATE location_settings SET cash_discrepancy_threshold = $1 WHERE location_id = $2",
      ["10.00", tenant.locationId],
    );
    const day = await openBusinessDay(pool, tenant.locationId, "100.00");
    await closeBusinessDay(pool, tenant.locationId, day.id, {
      expectedCash: "100.00",
      countedCash: "85.00", // 15 € short, above the 10 € threshold
      varianceReason: "Écart constaté",
      nextOpeningCash: null,
      closedBy: context.userId,
    });

    const alerts = await getAlerts(context);

    const varianceAlert = alerts.find((alert) => alert.type === "cash_variance");
    expect(varianceAlert).toBeDefined();
    expect(varianceAlert?.message).toContain("15,00");
    expect(varianceAlert?.actionHref).toBe("/caisse");
  });

  it("stays silent when the variance is within the threshold", async () => {
    await pool.query(
      "UPDATE location_settings SET cash_discrepancy_threshold = $1 WHERE location_id = $2",
      ["20.00", tenant.locationId],
    );
    const day = await openBusinessDay(pool, tenant.locationId, "100.00");
    await closeBusinessDay(pool, tenant.locationId, day.id, {
      expectedCash: "100.00",
      countedCash: "95.00", // 5 € short, under the 20 € threshold
      varianceReason: null,
      nextOpeningCash: null,
      closedBy: context.userId,
    });

    expect(
      (await getAlerts(context)).find((alert) => alert.type === "cash_variance"),
    ).toBeUndefined();
  });

  it("stays silent for an establishment that has never closed a day", async () => {
    expect(
      (await getAlerts(context)).find((alert) => alert.type === "cash_variance"),
    ).toBeUndefined();
  });
});

describe("BI-06: ticket ouvert depuis trop longtemps", () => {
  it("fires only once a ticket has been open past the threshold", async () => {
    await openBusinessDay(pool, tenant.locationId, "0.00");
    const ticket = await openDirectSaleTicket(context);

    // Just opened: not stale yet.
    expect(
      (await getAlerts(context)).find((alert) => alert.type === "stale_ticket"),
    ).toBeUndefined();

    await pool.query("UPDATE orders SET created_at = now() - interval '4 hours' WHERE id = $1", [
      ticket.id,
    ]);

    const alerts = await getAlerts(context);
    const staleAlert = alerts.find((alert) => alert.type === "stale_ticket");
    expect(staleAlert).toBeDefined();
    expect(staleAlert?.message).toContain("1 ticket");
    expect(staleAlert?.actionHref).toBe("/caisse");
  });
});

describe("BI-06: paiement ou mouvement anormal", () => {
  it("fires when a cash movement is recorded without a precise category (OTHER)", async () => {
    const day = await openBusinessDay(pool, tenant.locationId, "0.00");
    await createCashMovement(pool, tenant.locationId, {
      businessDayId: day.id,
      type: "OUT",
      category: "OTHER",
      amount: "12.00",
      reason: "Divers",
      createdBy: context.userId,
    });

    const alerts = await getAlerts(context);

    const anomalyAlert = alerts.find((alert) => alert.type === "anomaly");
    expect(anomalyAlert).toBeDefined();
    expect(anomalyAlert?.actionHref).toBe("/bilan");
  });

  it("stays silent when every movement carries a precise category", async () => {
    const day = await openBusinessDay(pool, tenant.locationId, "0.00");
    await createCashMovement(pool, tenant.locationId, {
      businessDayId: day.id,
      type: "OUT",
      category: "PURCHASE",
      amount: "12.00",
      reason: "Achat",
      createdBy: context.userId,
    });

    expect((await getAlerts(context)).find((alert) => alert.type === "anomaly")).toBeUndefined();
  });
});

describe("BI-06: clôture en retard", () => {
  it("fires once the open service has run past the threshold", async () => {
    const day = await openBusinessDay(pool, tenant.locationId, "0.00");

    expect(
      (await getAlerts(context)).find((alert) => alert.type === "late_closing"),
    ).toBeUndefined();

    await pool.query(
      "UPDATE business_days SET opened_at = now() - interval '17 hours' WHERE id = $1",
      [day.id],
    );

    const alerts = await getAlerts(context);
    const lateAlert = alerts.find((alert) => alert.type === "late_closing");
    expect(lateAlert).toBeDefined();
    expect(lateAlert?.severity).toBe("critical");
    expect(lateAlert?.actionHref).toBe("/caisse");
  });
});

describe("BI-06: at most five, in the documented priority order", () => {
  it("orders stock before cash_variance before stale_ticket before anomaly before late_closing", async () => {
    // Trigger all five at once.
    await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "Rupture",
      price: "5.00",
      stockQuantity: 0,
    });
    await pool.query(
      "UPDATE location_settings SET cash_discrepancy_threshold = $1 WHERE location_id = $2",
      ["1.00", tenant.locationId],
    );
    const closedDay = await openBusinessDay(pool, tenant.locationId, "0.00");
    await closeBusinessDay(pool, tenant.locationId, closedDay.id, {
      expectedCash: "0.00",
      countedCash: "50.00",
      varianceReason: "Test",
      nextOpeningCash: null,
      closedBy: context.userId,
    });
    const day = await openBusinessDay(pool, tenant.locationId, "0.00");
    const ticket = await openDirectSaleTicket(context);
    await pool.query("UPDATE orders SET created_at = now() - interval '4 hours' WHERE id = $1", [
      ticket.id,
    ]);
    await createCashMovement(pool, tenant.locationId, {
      businessDayId: day.id,
      type: "OUT",
      category: "OTHER",
      amount: "1.00",
      reason: "Divers",
      createdBy: context.userId,
    });
    await pool.query(
      "UPDATE business_days SET opened_at = now() - interval '17 hours' WHERE id = $1",
      [day.id],
    );

    const alerts = await getAlerts(context);

    expect(alerts).toHaveLength(5);
    expect(alerts.map((alert) => alert.type)).toEqual([
      "stock",
      "cash_variance",
      "stale_ticket",
      "anomaly",
      "late_closing",
    ]);
  });
});

describe("BI-06: tenant isolation", () => {
  it("never raises an alert from another establishment's data", async () => {
    const otherTenant = await createTestTenant(pool, "Other Alerts Tenant");
    await createTestUser(pool, otherTenant, "OWNER");
    await createProduct(pool, otherTenant.locationId, {
      categoryId: null,
      name: "Rupture chez l'autre",
      price: "5.00",
      stockQuantity: 0,
    });
    await openBusinessDay(pool, otherTenant.locationId, "0.00");

    expect(await getAlerts(context)).toEqual([]);
  });
});
