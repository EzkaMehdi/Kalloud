import { beforeEach, describe, expect, it } from "vitest";
import { pool } from "../../lib/db";
import {
  closeBusinessDay,
  getActiveBusinessDay,
  openBusinessDay,
} from "../../lib/repositories/business-days";
import {
  listCashMovementsHistory,
  createCashMovement,
} from "../../lib/repositories/cash-movements";
import { listPaymentsHistory } from "../../lib/repositories/payments";
import { listSoldItems } from "../../lib/repositories/orders";
import { createProduct as createProductRow } from "../../lib/repositories/products";
import { listStockMovementsHistory } from "../../lib/repositories/stock-movements";
import { adjustProductStock } from "../../lib/services/stock";
import { refundOrder } from "../../lib/services/refunds";
import { parseOrThrow } from "../../lib/validation/parse";
import { refundOrderSchema } from "../../lib/validation/schemas";
import { sell } from "./helpers/sales";
import { createTestTenant, createTestUser, type TestTenant } from "./helpers/fixtures";
import { resetDatabase } from "./helpers/reset-database";
import type { RequestContext } from "../../lib/context";

/**
 * BI-02's acceptance criterion, verbatim: "aucune agrégation entre
 * établissements ; performances mesurées." Four new establishment-wide,
 * filterable, paginated history queries (ventes, paiements, caisse, stock)
 * — `listOrderHistory` (ORD-12, "commandes") already has this shape and its
 * own tests, so it is not repeated here.
 */

let tenant: TestTenant;
let context: RequestContext;
let coffee: { id: number; name: string };
let tea: { id: number; name: string };

beforeEach(async () => {
  await resetDatabase(pool);
  tenant = await createTestTenant(pool, "History Tenant");
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
  await openBusinessDay(pool, tenant.locationId, "50.00");
  coffee = await createProductRow(pool, tenant.locationId, {
    categoryId: null,
    name: "Café",
    price: "10.00",
    stockQuantity: 20,
  });
  tea = await createProductRow(pool, tenant.locationId, {
    categoryId: null,
    name: "Thé",
    price: "5.00",
    stockQuantity: 20,
  });
});

async function otherTenantWithData() {
  const otherTenant = await createTestTenant(pool, "Other Tenant");
  const otherOwner = await createTestUser(pool, otherTenant, "OWNER");
  const otherContext: RequestContext = {
    userId: otherOwner.userId,
    userEmail: otherOwner.email,
    userName: "Other Owner",
    organizationId: otherTenant.organizationId,
    locationId: otherTenant.locationId,
    role: "OWNER",
    sessionId: 1,
  };
  const otherDay = await openBusinessDay(pool, otherTenant.locationId, "0.00");
  const product = await createProductRow(pool, otherTenant.locationId, {
    categoryId: null,
    name: "Produit d'un autre établissement",
    price: "1.00",
    stockQuantity: 10,
  });
  await sell(otherContext, [{ productId: product.id, quantity: 1 }], { paymentMethod: "CARD" });
  await createCashMovement(pool, otherTenant.locationId, {
    businessDayId: otherDay.id,
    type: "IN",
    category: "FUND_TOPUP",
    amount: "5.00",
    reason: "Mouvement d'un autre établissement",
    createdBy: otherOwner.userId,
  });
  await adjustProductStock(otherContext, product.id, {
    delta: 3,
    type: "RECEIPT",
    reason: "Réception chez l'autre établissement",
  });
  return { otherTenant, otherContext, product };
}

describe("BI-02: ventes (order lines, across the establishment)", () => {
  it("lists lines newest first, including the line of a later-refunded order", async () => {
    const coffeeSale = await sell(context, [{ productId: coffee.id, quantity: 1 }], {
      paymentMethod: "CASH",
    });
    await sell(context, [{ productId: tea.id, quantity: 1 }], {
      paymentMethod: "CARD",
    });
    await refundOrder(
      context,
      coffeeSale.order.id,
      parseOrThrow(refundOrderSchema, { reason: "Produit renvoyé" }),
    );

    const page = await listSoldItems(pool, tenant.locationId, { limit: 20, offset: 0 });

    expect(page.total).toBe(2);
    expect(page.items.map((item) => item.product_name)).toEqual(["Thé", "Café"]);
    // A refund reverses payment, never the sale itself (DEC-05/ORD-10):
    // the refunded order's line is still a real "vente".
    const coffeeLine = page.items.find((item) => item.order_id === coffeeSale.order.id);
    expect(coffeeLine?.sold_at).not.toBeNull();
  });

  it("filters by product", async () => {
    await sell(context, [{ productId: coffee.id, quantity: 1 }], { paymentMethod: "CASH" });
    await sell(context, [{ productId: tea.id, quantity: 1 }], { paymentMethod: "CARD" });

    const page = await listSoldItems(pool, tenant.locationId, {
      productId: coffee.id,
      limit: 20,
      offset: 0,
    });

    expect(page.total).toBe(1);
    expect(page.items[0].product_name).toBe("Café");
  });

  it("filters by date range", async () => {
    await sell(context, [{ productId: coffee.id, quantity: 1 }], { paymentMethod: "CASH" });
    const anHourAgo = new Date(Date.now() - 3_600_000).toISOString();

    const before = await listSoldItems(pool, tenant.locationId, {
      to: anHourAgo,
      limit: 20,
      offset: 0,
    });
    const after = await listSoldItems(pool, tenant.locationId, {
      from: anHourAgo,
      limit: 20,
      offset: 0,
    });

    expect(before.total).toBe(0);
    expect(after.total).toBe(1);
  });

  it("paginates with an accurate total", async () => {
    await sell(context, [{ productId: coffee.id, quantity: 1 }], { paymentMethod: "CASH" });
    await sell(context, [{ productId: tea.id, quantity: 1 }], { paymentMethod: "CARD" });

    const firstPage = await listSoldItems(pool, tenant.locationId, { limit: 1, offset: 0 });
    const secondPage = await listSoldItems(pool, tenant.locationId, { limit: 1, offset: 1 });

    expect(firstPage.total).toBe(2);
    expect(secondPage.total).toBe(2);
    expect(firstPage.items[0].id).not.toBe(secondPage.items[0].id);
  });

  it("never aggregates another establishment's sales", async () => {
    await otherTenantWithData();
    await sell(context, [{ productId: coffee.id, quantity: 1 }], { paymentMethod: "CASH" });

    const page = await listSoldItems(pool, tenant.locationId, { limit: 20, offset: 0 });

    expect(page.total).toBe(1);
    expect(page.items[0].product_name).toBe("Café");
  });
});

describe("BI-02: paiements (the CHARGE/REFUND ledger, across the establishment)", () => {
  it("lists every charge and refund line, filterable by method and type", async () => {
    const coffeeSale = await sell(context, [{ productId: coffee.id, quantity: 1 }], {
      paymentMethod: "CASH",
    });
    await sell(context, [{ productId: tea.id, quantity: 1 }], { paymentMethod: "CARD" });
    await refundOrder(
      context,
      coffeeSale.order.id,
      parseOrThrow(refundOrderSchema, { reason: "Produit renvoyé" }),
    );

    const all = await listPaymentsHistory(pool, tenant.locationId, { limit: 20, offset: 0 });
    expect(all.total).toBe(3); // CASH charge, CASH refund, CARD charge

    const cashOnly = await listPaymentsHistory(pool, tenant.locationId, {
      method: "CASH",
      limit: 20,
      offset: 0,
    });
    expect(cashOnly.total).toBe(2);

    const refundsOnly = await listPaymentsHistory(pool, tenant.locationId, {
      type: "REFUND",
      limit: 20,
      offset: 0,
    });
    expect(refundsOnly.total).toBe(1);
    expect(refundsOnly.payments[0].order_number).toBe(coffeeSale.order.order_number);
  });

  it("never aggregates another establishment's payments", async () => {
    await otherTenantWithData();
    await sell(context, [{ productId: coffee.id, quantity: 1 }], { paymentMethod: "CASH" });

    const page = await listPaymentsHistory(pool, tenant.locationId, { limit: 20, offset: 0 });

    expect(page.total).toBe(1);
  });
});

describe("BI-02: caisse (movement history, beyond the open service's own journal)", () => {
  it("lists movements filterable by type and category, unlike CASH-07's live journal, still readable after the service closes", async () => {
    // beforeEach already opened one day for this tenant — reused here
    // rather than opening a second (only one may be OPEN at a time).
    const day = (await getActiveBusinessDay(pool, tenant.locationId))!;
    await createCashMovement(pool, tenant.locationId, {
      businessDayId: day.id,
      type: "IN",
      category: "FUND_TOPUP",
      amount: "20.00",
      reason: "Appoint de monnaie",
      createdBy: context.userId,
    });
    await createCashMovement(pool, tenant.locationId, {
      businessDayId: day.id,
      type: "OUT",
      category: "PURCHASE",
      amount: "15.00",
      reason: "Achat de consommables",
      createdBy: context.userId,
    });

    await closeBusinessDay(pool, tenant.locationId, day.id, {
      expectedCash: "5.00",
      countedCash: "5.00",
      varianceReason: null,
      nextOpeningCash: null,
      closedBy: context.userId,
    });

    // CASH-07's own GET /api/cash-movements would answer [] here — no
    // service is open. This is the distinct question BI-02 asks: what
    // happened, regardless of what is open right now.
    const all = await listCashMovementsHistory(pool, tenant.locationId, { limit: 20, offset: 0 });
    expect(all.total).toBe(2);

    const inOnly = await listCashMovementsHistory(pool, tenant.locationId, {
      type: "IN",
      limit: 20,
      offset: 0,
    });
    expect(inOnly.total).toBe(1);

    const purchasesOnly = await listCashMovementsHistory(pool, tenant.locationId, {
      category: "PURCHASE",
      limit: 20,
      offset: 0,
    });
    expect(purchasesOnly.total).toBe(1);
    expect(purchasesOnly.movements[0].amount).toBe("15.00");
  });

  it("filters by date range", async () => {
    const day = (await getActiveBusinessDay(pool, tenant.locationId))!;
    await createCashMovement(pool, tenant.locationId, {
      businessDayId: day.id,
      type: "IN",
      category: "FUND_TOPUP",
      amount: "20.00",
      reason: "Appoint",
      createdBy: context.userId,
    });
    const anHourAgo = new Date(Date.now() - 3_600_000).toISOString();

    const before = await listCashMovementsHistory(pool, tenant.locationId, {
      to: anHourAgo,
      limit: 20,
      offset: 0,
    });

    expect(before.total).toBe(0);
  });

  it("never aggregates another establishment's movements", async () => {
    await otherTenantWithData();
    const day = (await getActiveBusinessDay(pool, tenant.locationId))!;
    await createCashMovement(pool, tenant.locationId, {
      businessDayId: day.id,
      type: "IN",
      category: "FUND_TOPUP",
      amount: "20.00",
      reason: "Appoint",
      createdBy: context.userId,
    });

    const page = await listCashMovementsHistory(pool, tenant.locationId, { limit: 20, offset: 0 });

    expect(page.total).toBe(1);
  });
});

describe("BI-02: stock (ledger across every product)", () => {
  it("lists movements across all products, filterable by product and type", async () => {
    await sell(context, [{ productId: coffee.id, quantity: 1 }], { paymentMethod: "CASH" }); // SALE on coffee
    await adjustProductStock(context, coffee.id, {
      delta: 5,
      type: "RECEIPT",
      reason: "Livraison",
    });
    await adjustProductStock(context, tea.id, { delta: -2, type: "LOSS", reason: "Casse" });

    const all = await listStockMovementsHistory(pool, tenant.locationId, { limit: 20, offset: 0 });
    expect(all.total).toBe(3); // SALE + RECEIPT + LOSS

    const coffeeOnly = await listStockMovementsHistory(pool, tenant.locationId, {
      productId: coffee.id,
      limit: 20,
      offset: 0,
    });
    expect(coffeeOnly.total).toBe(2); // SALE + RECEIPT
    expect(coffeeOnly.movements.every((movement) => movement.product_name === "Café")).toBe(true);

    const lossesOnly = await listStockMovementsHistory(pool, tenant.locationId, {
      type: "LOSS",
      limit: 20,
      offset: 0,
    });
    expect(lossesOnly.total).toBe(1);
    expect(lossesOnly.movements[0].product_name).toBe("Thé");
  });

  it("never aggregates another establishment's stock movements", async () => {
    await otherTenantWithData();
    await adjustProductStock(context, coffee.id, {
      delta: 5,
      type: "RECEIPT",
      reason: "Livraison",
    });

    const page = await listStockMovementsHistory(pool, tenant.locationId, { limit: 20, offset: 0 });

    expect(page.total).toBe(1);
  });
});

describe("BI-02: performances mesurées — migrations/0019 adds the index each query needs", () => {
  /**
   * An earlier version of this suite asked Postgres' own planner to prove
   * it, via `EXPLAIN` under `enable_seqscan = OFF`. That turned out to be
   * the wrong tool for a test fixture: with only a handful of rows (or
   * none, freshly truncated between tests), several indexes tie on cost,
   * and *which* one the planner reaches for is no longer determined by the
   * query's own shape — it flipped between runs in this same suite,
   * failing on a table that had nothing wrong with it. The property this
   * task can actually guarantee, independent of how much data happens to
   * exist at test time, is structural: does the exact index
   * migrations/0019 claims to add exist, over the right columns, in the
   * right order (`location_id` first, so it can seek to one establishment
   * before ever reading a row) — checked directly against Postgres'
   * catalog rather than inferred from a plan the planner was free to pick
   * for other reasons.
   */
  async function indexColumns(indexName: string): Promise<string> {
    const { rows } = await pool.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE indexname = $1",
      [indexName],
    );
    expect(rows, `index "${indexName}" does not exist`).toHaveLength(1);
    // e.g. "CREATE INDEX ... ON public.stock_movements USING btree (location_id, created_at DESC)"
    return rows[0].indexdef.replace(/^.*\(/, "").replace(/\)\s*$/, "");
  }

  it("ventes: orders_location_status_paid_idx covers (location_id, status, paid_at)", async () => {
    const columns = await indexColumns("orders_location_status_paid_idx");
    expect(columns).toBe("location_id, status, paid_at DESC");
  });

  it("paiements: payments_location_created_idx covers (location_id, created_at)", async () => {
    const columns = await indexColumns("payments_location_created_idx");
    expect(columns).toBe("location_id, created_at DESC");
  });

  it("caisse: cash_movements_location_created_idx covers (location_id, created_at)", async () => {
    const columns = await indexColumns("cash_movements_location_created_idx");
    expect(columns).toBe("location_id, created_at DESC");
  });

  it("stock: stock_movements_location_created_idx covers (location_id, created_at)", async () => {
    const columns = await indexColumns("stock_movements_location_created_idx");
    expect(columns).toBe("location_id, created_at DESC");
  });
});
