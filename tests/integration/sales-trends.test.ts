import { beforeEach, describe, expect, it } from "vitest";
import { pool } from "../../lib/db";
import { openBusinessDay } from "../../lib/repositories/business-days";
import { createDiningTable } from "../../lib/repositories/tables";
import { createProduct } from "../../lib/repositories/products";
import { getSalesTrends } from "../../lib/services/trends";
import { openOrResumeTableTicket, saveTicketItems } from "../../lib/services/tickets";
import { performCheckout } from "../../lib/services/checkout";
import { refundOrder } from "../../lib/services/refunds";
import { parseOrThrow } from "../../lib/validation/parse";
import { checkoutBodySchema, refundOrderSchema } from "../../lib/validation/schemas";
import { sell, type SaleLine, type SalePayment } from "./helpers/sales";
import { createTestTenant, createTestUser, type TestTenant } from "./helpers/fixtures";
import { resetDatabase } from "./helpers/reset-database";
import type { RequestContext } from "../../lib/context";

/**
 * BI-08's acceptance criterion, verbatim: "chaque valeur mène aux commandes
 * sources ; calcul de rotation limité aux tickets avec table." The second
 * half is tested directly (a counter sale must not appear in table
 * turnover or skew the average service duration); the first is tested by
 * checking every breakdown carries the identifying key (hour, calendar
 * day, product id, category id, table id) a future drill-down needs, not
 * just an anonymous total.
 */

let tenant: TestTenant;
let context: RequestContext;

beforeEach(async () => {
  await resetDatabase(pool);
  tenant = await createTestTenant(pool, "Trends Tenant");
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

async function sellAtTable(
  tableId: number,
  lines: SaleLine[],
  payment: SalePayment = { paymentMethod: "CARD" },
) {
  const { ticket } = await openOrResumeTableTicket(context, tableId);
  const updated = await saveTicketItems(context, ticket.id, {
    version: ticket.version,
    items: lines,
  });
  return performCheckout(
    context,
    parseOrThrow(checkoutBodySchema, { orderId: updated.id, ...payment }),
  );
}

async function setOrderTiming(orderId: number, createdAt: Date, paidAt: Date): Promise<void> {
  await pool.query("UPDATE orders SET created_at = $1, paid_at = $2 WHERE id = $3", [
    createdAt.toISOString(),
    paidAt.toISOString(),
    orderId,
  ]);
}

describe("BI-08: hourly and daily trend", () => {
  it("buckets net revenue and order count by local hour and by calendar day", async () => {
    await openBusinessDay(pool, tenant.locationId, "0.00");
    const product = await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "Café",
      price: "10.00",
      stockQuantity: 50,
    });

    const morning = await sell(context, [{ productId: product.id, quantity: 1 }], {
      paymentMethod: "CASH",
    });
    await setOrderTiming(
      morning.order.id,
      new Date("2026-03-10T08:30:00+01:00"),
      new Date("2026-03-10T08:30:00+01:00"),
    );

    const evening = await sell(context, [{ productId: product.id, quantity: 2 }], {
      paymentMethod: "CASH",
    }); // 20.00
    await setOrderTiming(
      evening.order.id,
      new Date("2026-03-10T20:00:00+01:00"),
      new Date("2026-03-10T20:00:00+01:00"),
    );

    const nextDay = await sell(context, [{ productId: product.id, quantity: 1 }], {
      paymentMethod: "CASH",
    });
    await setOrderTiming(
      nextDay.order.id,
      new Date("2026-03-11T08:30:00+01:00"),
      new Date("2026-03-11T08:30:00+01:00"),
    );

    const result = await getSalesTrends(
      tenant.locationId,
      new Date("2026-03-10T00:00:00+01:00"),
      new Date("2026-03-12T00:00:00+01:00"),
    );

    const hour8 = result.hourly.find((row) => row.hour === 8);
    const hour20 = result.hourly.find((row) => row.hour === 20);
    expect(hour8?.orders_count).toBe(2); // the 10th and the 11th, both at 08:30
    expect(hour20?.revenue).toBe("20.00");
    expect(hour20?.orders_count).toBe(1);

    const day10 = result.daily.find((row) => row.date === "2026-03-10");
    const day11 = result.daily.find((row) => row.date === "2026-03-11");
    expect(day10?.revenue).toBe("30.00"); // 10.00 + 20.00
    expect(day10?.orders_count).toBe(2);
    expect(day11?.revenue).toBe("10.00");
    expect(day11?.orders_count).toBe(1);
  });
});

describe("BI-08: sales by product and by category", () => {
  it("aggregates line revenue and quantity, keyed by product and by category, including a refunded order's lines", async () => {
    await openBusinessDay(pool, tenant.locationId, "0.00");
    const {
      rows: [category],
    } = await pool.query<{ id: number }>(
      "INSERT INTO categories (location_id, name) VALUES ($1, $2) RETURNING id",
      [tenant.locationId, "Boissons"],
    );
    const coffee = await createProduct(pool, tenant.locationId, {
      categoryId: category.id,
      name: "Café",
      price: "5.00",
      stockQuantity: 50,
    });
    const chicha = await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "Chicha Signature",
      price: "20.00",
      stockQuantity: 50,
    });

    await sell(context, [{ productId: coffee.id, quantity: 3 }], { paymentMethod: "CASH" }); // 15.00
    const refundedSale = await sell(context, [{ productId: chicha.id, quantity: 1 }], {
      paymentMethod: "CARD",
    });
    await refundOrder(
      context,
      refundedSale.order.id,
      parseOrThrow(refundOrderSchema, { reason: "Insatisfait" }),
    );

    const from = new Date(Date.now() - 3_600_000);
    const to = new Date(Date.now() + 3_600_000);
    const result = await getSalesTrends(tenant.locationId, from, to);

    const coffeeRow = result.byProduct.find((row) => row.product_id === coffee.id);
    expect(coffeeRow).toMatchObject({ product_name: "Café", quantity: 3, revenue: "15.00" });
    expect(coffeeRow?.category_id).toBe(category.id);

    // The refunded order's line is still counted — a per-product report
    // that silently dropped it would disagree with BI-02's own
    // listSoldItems, which includes REFUNDED orders for the same reason.
    const chichaRow = result.byProduct.find((row) => row.product_id === chicha.id);
    expect(chichaRow).toMatchObject({ product_name: "Chicha Signature", revenue: "20.00" });

    const categoryRow = result.byCategory.find((row) => row.category_id === category.id);
    expect(categoryRow).toMatchObject({ category_name: "Boissons", quantity: 3, revenue: "15.00" });
    const uncategorised = result.byCategory.find((row) => row.category_id === null);
    expect(uncategorised).toMatchObject({ category_name: "Sans catégorie", revenue: "20.00" });
  });
});

describe("BI-08: table turnover and average service duration exclude counter sales", () => {
  it("counts tickets and averages duration per table, ignoring a counter sale entirely", async () => {
    await openBusinessDay(pool, tenant.locationId, "0.00");
    const product = await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "Café",
      price: "5.00",
      stockQuantity: 50,
    });
    const table1 = await createDiningTable(pool, tenant.locationId, "Table 1");

    const ticketA = await sellAtTable(table1.id, [{ productId: product.id, quantity: 1 }]);
    await setOrderTiming(
      ticketA.order.id,
      new Date("2026-03-10T12:00:00+01:00"),
      new Date("2026-03-10T12:10:00+01:00"), // 10 minutes
    );
    const ticketB = await sellAtTable(table1.id, [{ productId: product.id, quantity: 1 }]);
    await setOrderTiming(
      ticketB.order.id,
      new Date("2026-03-10T13:00:00+01:00"),
      new Date("2026-03-10T13:20:00+01:00"), // 20 minutes
    );

    // A counter sale ("vente directe"): no table, must not appear in table
    // turnover, and must not pull the average service duration toward its
    // own near-instant open-to-paid time.
    const counterSale = await sell(context, [{ productId: product.id, quantity: 1 }]);
    await setOrderTiming(
      counterSale.order.id,
      new Date("2026-03-10T14:00:00+01:00"),
      new Date("2026-03-10T14:00:01+01:00"), // ~instant
    );

    const from = new Date("2026-03-10T00:00:00+01:00");
    const to = new Date("2026-03-11T00:00:00+01:00");
    const result = await getSalesTrends(tenant.locationId, from, to);

    expect(result.tableTurnover).toHaveLength(1);
    const row = result.tableTurnover[0];
    expect(row.table_id).toBe(table1.id);
    expect(row.table_name).toBe("Table 1");
    expect(row.tickets_count).toBe(2);
    expect(Number(row.average_service_minutes)).toBeCloseTo(15, 1); // (10 + 20) / 2

    // The counter sale's near-zero duration is excluded, not blended in —
    // an average dragged toward it would misreport every table's own pace.
    expect(Number(result.averageServiceMinutes)).toBeCloseTo(15, 1);
  });
});

describe("BI-08: tenant isolation", () => {
  it("never mixes another establishment's sales into any breakdown", async () => {
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
    await openBusinessDay(pool, otherTenant.locationId, "0.00");
    const otherProduct = await createProduct(pool, otherTenant.locationId, {
      categoryId: null,
      name: "Produit d'un autre établissement",
      price: "999.00",
      stockQuantity: 5,
    });
    await sell(otherContext, [{ productId: otherProduct.id, quantity: 1 }], {
      paymentMethod: "CARD",
    });

    const from = new Date(Date.now() - 3_600_000);
    const to = new Date(Date.now() + 3_600_000);
    const result = await getSalesTrends(tenant.locationId, from, to);

    expect(result.byProduct).toHaveLength(0);
    expect(result.byCategory).toHaveLength(0);
    expect(result.tableTurnover).toHaveLength(0);
  });
});
