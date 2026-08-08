import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { pool } from "../../lib/db";
import { ConflictError, NotFoundError, ValidationError } from "../../lib/errors";
import { withIdempotency } from "../../lib/idempotency";
import {
  getActiveBusinessDay,
  getBusinessDaySummary,
  openBusinessDay,
} from "../../lib/repositories/business-days";
import { getCashBalance } from "../../lib/repositories/cash-movements";
import { listOrders } from "../../lib/repositories/orders";
import { createProduct, listProducts, type ProductRow } from "../../lib/repositories/products";
import { createDiningTable, listDiningTables } from "../../lib/repositories/tables";
import { performCheckout } from "../../lib/services/checkout";
import {
  getTicket,
  openDirectSaleTicket,
  openOrResumeTableTicket,
  saveTicketItems,
} from "../../lib/services/tickets";
import { parseOrThrow } from "../../lib/validation/parse";
import { checkoutBodySchema } from "../../lib/validation/schemas";
import { createTestTenant, createTestUser, type TestTenant } from "./helpers/fixtures";
import { resetDatabase } from "./helpers/reset-database";
import type { RequestContext } from "../../lib/context";

/**
 * ORD-02 to ORD-05: the persistent ticket.
 *
 * These assert against the database rather than against return values
 * wherever the guarantee is about persistence — "aucun article perdu" and
 * "au plus un ticket ouvert par table" are claims about rows, and a service
 * that returned the right object while writing the wrong thing would pass a
 * weaker test.
 */

let tenant: TestTenant;
let context: RequestContext;
let otherContext: RequestContext;
let tableId: number;
let coffee: ProductRow;
let tea: ProductRow;

async function contextFor(name: string): Promise<RequestContext> {
  const user = await createTestUser(pool, tenant, "OWNER");
  return {
    userId: user.userId,
    userEmail: user.email,
    userName: name,
    organizationId: tenant.organizationId,
    locationId: tenant.locationId,
    role: "OWNER",
    sessionId: 1,
  };
}

beforeEach(async () => {
  await resetDatabase(pool);
  tenant = await createTestTenant(pool, "Ticket Tenant");
  context = await contextFor("Serveur A");
  // A second device/user on the same establishment, for the conflict cases.
  otherContext = await contextFor("Serveur B");
  await openBusinessDay(pool, tenant.locationId, "100.00");
  tableId = (await createDiningTable(pool, tenant.locationId, "T1")).id;
  coffee = await createProduct(pool, tenant.locationId, {
    categoryId: null,
    name: "Café",
    price: "2.50",
    stockQuantity: 20,
  });
  tea = await createProduct(pool, tenant.locationId, {
    categoryId: null,
    name: "Thé",
    price: "3.00",
    stockQuantity: 20,
  });
});

describe("ORD-02: a table carries at most one open ticket", () => {
  it("resumes the existing ticket instead of opening a second one", async () => {
    const first = await openOrResumeTableTicket(context, tableId);
    expect(first.created).toBe(true);

    const second = await openOrResumeTableTicket(context, tableId);
    expect(second.created).toBe(false);
    expect(second.ticket.id).toBe(first.ticket.id);

    const { rows } = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::TEXT AS count FROM orders WHERE location_id = $1 AND status = 'OPEN'",
      [tenant.locationId],
    );
    expect(rows[0].count).toBe("1");
  });

  it("resolves two devices opening the same table at once to one ticket", async () => {
    const outcomes = await Promise.allSettled([
      openOrResumeTableTicket(context, tableId),
      openOrResumeTableTicket(otherContext, tableId),
    ]);

    // One creates it; the other either resumes it or is told to reload —
    // never a second live ticket on the same table.
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") {
        expect(outcome.reason).toBeInstanceOf(ConflictError);
      }
    }
    const { rows } = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::TEXT AS count FROM orders WHERE location_id = $1 AND status = 'OPEN'",
      [tenant.locationId],
    );
    expect(rows[0].count).toBe("1");
  });

  it("refuses to open a ticket with no business day", async () => {
    await pool.query("UPDATE business_days SET status = 'CLOSED' WHERE location_id = $1", [
      tenant.locationId,
    ]);
    await expect(openOrResumeTableTicket(context, tableId)).rejects.toBeInstanceOf(ValidationError);
  });

  it("refuses a table from another establishment as if it did not exist", async () => {
    const other = await createTestTenant(pool, "Other Tenant");
    const otherTable = await createDiningTable(pool, other.locationId, "X1");
    await expect(openOrResumeTableTicket(context, otherTable.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe("ORD-03: table occupancy is derived from the ticket", () => {
  it("reports a table occupied exactly while it has an open ticket", async () => {
    const before = await listDiningTables(pool, tenant.locationId);
    expect(before[0].is_occupied).toBe(false);
    expect(before[0].open_order_id).toBeNull();

    const { ticket } = await openOrResumeTableTicket(context, tableId);
    const during = await listDiningTables(pool, tenant.locationId);
    expect(during[0].is_occupied).toBe(true);
    expect(during[0].open_order_id).toBe(ticket.id);
  });

  it("frees the table by the same fact that records the sale", async () => {
    const { ticket } = await openOrResumeTableTicket(context, tableId);
    await saveTicketItems(context, ticket.id, {
      version: ticket.version,
      items: [{ productId: coffee.id, quantity: 2 }],
    });

    await performCheckout(
      context,
      parseOrThrow(checkoutBodySchema, { orderId: ticket.id, paymentMethod: "CARD" }),
    );

    // No second write frees the table — the order simply stopped being OPEN.
    const after = await listDiningTables(pool, tenant.locationId);
    expect(after[0].is_occupied).toBe(false);
    expect(after[0].open_order_id).toBeNull();
  });

  it("shows the open ticket's running total on the floor plan", async () => {
    const { ticket } = await openOrResumeTableTicket(context, tableId);
    await saveTicketItems(context, ticket.id, {
      version: ticket.version,
      items: [{ productId: coffee.id, quantity: 2 }],
    });

    const tables = await listDiningTables(pool, tenant.locationId);
    expect(tables[0].open_order_total).toBe("5.00");
  });
});

describe("ORD-04: a ticket survives the browser", () => {
  it("returns the same lines to a caller that reloads it from scratch", async () => {
    const { ticket } = await openOrResumeTableTicket(context, tableId);
    await saveTicketItems(context, ticket.id, {
      version: ticket.version,
      items: [
        { productId: coffee.id, quantity: 2 },
        { productId: tea.id, quantity: 1 },
      ],
    });

    // Nothing carried over from the first call: this is what a refresh does.
    const reloaded = await getTicket(context, ticket.id);
    expect(reloaded.items).toHaveLength(2);
    expect(reloaded.items.map((item) => [item.product_id, item.quantity])).toEqual([
      [coffee.id, 2],
      [tea.id, 1],
    ]);
    expect(reloaded.total_amount).toBe("8.00");
  });

  it("prices lines from the catalog, never from the caller", async () => {
    const { ticket } = await openOrResumeTableTicket(context, tableId);
    const saved = await saveTicketItems(context, ticket.id, {
      version: ticket.version,
      items: [{ productId: coffee.id, quantity: 1 }],
    });
    expect(saved.items[0].unit_price).toBe("2.50");
  });

  it("refuses a product from another establishment", async () => {
    const other = await createTestTenant(pool, "Other Tenant");
    const foreign = await createProduct(pool, other.locationId, {
      categoryId: null,
      name: "Foreign",
      price: "9.00",
      stockQuantity: 5,
    });
    const { ticket } = await openOrResumeTableTicket(context, tableId);

    await expect(
      saveTicketItems(context, ticket.id, {
        version: ticket.version,
        items: [{ productId: foreign.id, quantity: 1 }],
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("ORD-05: concurrent edits do not overwrite each other", () => {
  it("refuses a save made against a stale version", async () => {
    const { ticket } = await openOrResumeTableTicket(context, tableId);
    const staleVersion = ticket.version;

    // Device A saves first.
    await saveTicketItems(context, ticket.id, {
      version: staleVersion,
      items: [{ productId: coffee.id, quantity: 1 }],
    });

    // Device B still holds the version it loaded before that.
    await expect(
      saveTicketItems(otherContext, ticket.id, {
        version: staleVersion,
        items: [{ productId: tea.id, quantity: 5 }],
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    // Device A's line is intact — B's stale list did not become the truth.
    const current = await getTicket(context, ticket.id);
    expect(current.items).toHaveLength(1);
    expect(current.items[0].product_id).toBe(coffee.id);
  });

  it("lets the refused device continue once it reloads", async () => {
    const { ticket } = await openOrResumeTableTicket(context, tableId);
    await saveTicketItems(context, ticket.id, {
      version: ticket.version,
      items: [{ productId: coffee.id, quantity: 1 }],
    });

    const reloaded = await getTicket(otherContext, ticket.id);
    const saved = await saveTicketItems(otherContext, ticket.id, {
      version: reloaded.version,
      items: [
        { productId: coffee.id, quantity: 1 },
        { productId: tea.id, quantity: 1 },
      ],
    });
    expect(saved.items).toHaveLength(2);
  });

  it("bumps the version on every save", async () => {
    const { ticket } = await openOrResumeTableTicket(context, tableId);
    const first = await saveTicketItems(context, ticket.id, {
      version: ticket.version,
      items: [{ productId: coffee.id, quantity: 1 }],
    });
    expect(first.version).toBe(ticket.version + 1);
    const second = await saveTicketItems(context, ticket.id, {
      version: first.version,
      items: [{ productId: coffee.id, quantity: 2 }],
    });
    expect(second.version).toBe(first.version + 1);
  });

  it("merges repeated lines of the same product into one", async () => {
    const { ticket } = await openOrResumeTableTicket(context, tableId);
    const saved = await saveTicketItems(context, ticket.id, {
      version: ticket.version,
      items: [
        { productId: coffee.id, quantity: 2 },
        { productId: coffee.id, quantity: 3 },
      ],
    });
    expect(saved.items).toHaveLength(1);
    expect(saved.items[0].quantity).toBe(5);
  });

  it("accepts emptying a ticket, which is a real action", async () => {
    const { ticket } = await openOrResumeTableTicket(context, tableId);
    const filled = await saveTicketItems(context, ticket.id, {
      version: ticket.version,
      items: [{ productId: coffee.id, quantity: 1 }],
    });
    const emptied = await saveTicketItems(context, ticket.id, {
      version: filled.version,
      items: [],
    });
    expect(emptied.items).toHaveLength(0);
    expect(emptied.total_amount).toBe("0.00");
  });
});

describe("ORD-04: paying a ticket charges what the ticket holds", () => {
  it("uses the persisted lines, not what the caller sends", async () => {
    const { ticket } = await openOrResumeTableTicket(context, tableId);
    await saveTicketItems(context, ticket.id, {
      version: ticket.version,
      items: [{ productId: coffee.id, quantity: 4 }],
    });

    const result = await performCheckout(
      context,
      // The caller offers a cheaper line list; the ticket is what counts.
      parseOrThrow(checkoutBodySchema, {
        orderId: ticket.id,
        items: [{ productId: coffee.id, quantity: 1 }],
        paymentMethod: "CARD",
      }),
    );

    expect(result.order.total_amount).toBe("10.00");
    const products = await listProducts(pool, tenant.locationId);
    expect(products.find((row) => row.id === coffee.id)?.stock_quantity).toBe(16);
  });

  it("keeps the ticket's identity and number rather than creating a second order", async () => {
    const { ticket } = await openOrResumeTableTicket(context, tableId);
    await saveTicketItems(context, ticket.id, {
      version: ticket.version,
      items: [{ productId: coffee.id, quantity: 1 }],
    });

    const result = await performCheckout(
      context,
      parseOrThrow(checkoutBodySchema, { orderId: ticket.id, paymentMethod: "CASH" }),
    );

    expect(result.order.id).toBe(ticket.id);
    expect(result.order.order_number).toBe(ticket.order_number);
    const orders = await listOrders(pool, tenant.locationId);
    expect(orders).toHaveLength(1);
    expect(orders[0].status).toBe("PAID");
  });

  it("refuses to pay the same ticket twice", async () => {
    const { ticket } = await openOrResumeTableTicket(context, tableId);
    await saveTicketItems(context, ticket.id, {
      version: ticket.version,
      items: [{ productId: coffee.id, quantity: 1 }],
    });
    const body = parseOrThrow(checkoutBodySchema, { orderId: ticket.id, paymentMethod: "CARD" });

    await performCheckout(context, body);
    // A second, genuinely different request (no shared idempotency key) —
    // the row lock plus the status check is what stops it, not API-02.
    await expect(performCheckout(context, body)).rejects.toBeInstanceOf(ConflictError);

    expect(await listOrders(pool, tenant.locationId)).toHaveLength(1);
  });

  it("still refuses to modify a ticket once it is paid", async () => {
    const { ticket } = await openOrResumeTableTicket(context, tableId);
    const saved = await saveTicketItems(context, ticket.id, {
      version: ticket.version,
      items: [{ productId: coffee.id, quantity: 1 }],
    });
    await performCheckout(
      context,
      parseOrThrow(checkoutBodySchema, { orderId: ticket.id, paymentMethod: "CARD" }),
    );

    await expect(
      saveTicketItems(context, ticket.id, {
        version: saved.version,
        items: [{ productId: tea.id, quantity: 1 }],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("keeps idempotency working on a ticket payment", async () => {
    const { ticket } = await openOrResumeTableTicket(context, tableId);
    await saveTicketItems(context, ticket.id, {
      version: ticket.version,
      items: [{ productId: coffee.id, quantity: 1 }],
    });
    const body = parseOrThrow(checkoutBodySchema, { orderId: ticket.id, paymentMethod: "CARD" });
    const key = randomUUID();

    const first = await withIdempotency(
      context,
      { endpoint: "POST /api/checkout", key, payload: body },
      () => performCheckout(context, body),
    );
    const retry = await withIdempotency(
      context,
      { endpoint: "POST /api/checkout", key, payload: body },
      () => performCheckout(context, body),
    );

    expect(first.replayed).toBe(false);
    expect(retry.replayed).toBe(true);
    expect(await listOrders(pool, tenant.locationId)).toHaveLength(1);
  });
});

describe("ORD-02: an open ticket is not sales history", () => {
  it("keeps a ticket in progress out of the orders list until it is paid", async () => {
    const { ticket } = await openOrResumeTableTicket(context, tableId);
    await saveTicketItems(context, ticket.id, {
      version: ticket.version,
      items: [{ productId: coffee.id, quantity: 1 }],
    });

    // The Bilan reads this list under a "commandes encaissées" heading; a
    // running total with no payment method has no business appearing there.
    expect(await listOrders(pool, tenant.locationId)).toHaveLength(0);

    await performCheckout(
      context,
      parseOrThrow(checkoutBodySchema, { orderId: ticket.id, paymentMethod: "CARD" }),
    );
    const history = await listOrders(pool, tenant.locationId);
    expect(history).toHaveLength(1);
    expect(history[0].status).toBe("PAID");
  });

  it("leaves every money figure untouched while a ticket is only open", async () => {
    const day = await getActiveBusinessDay(pool, tenant.locationId);
    const cashBefore = await getCashBalance(pool, tenant.locationId, day!.id);

    const { ticket } = await openOrResumeTableTicket(context, tableId);
    await saveTicketItems(context, ticket.id, {
      version: ticket.version,
      items: [{ productId: coffee.id, quantity: 4 }],
    });

    // Revenue is recognised at payment, not at ordering: a 10 € ticket
    // sitting on a table must move nothing.
    const summary = await getBusinessDaySummary(pool, tenant.locationId, day!.id);
    expect(summary.revenue).toBe("0.00");
    expect(summary.orders_count).toBe(0);
    expect(await getCashBalance(pool, tenant.locationId, day!.id)).toBe(cashBefore);

    // And it does move once the ticket is paid in cash.
    await performCheckout(
      context,
      parseOrThrow(checkoutBodySchema, { orderId: ticket.id, paymentMethod: "CASH" }),
    );
    const paidSummary = await getBusinessDaySummary(pool, tenant.locationId, day!.id);
    expect(paidSummary.revenue).toBe("10.00");
    expect(paidSummary.cash_revenue).toBe("10.00");
  });
});

describe("ORD-07 groundwork: a direct sale is a ticket too", () => {
  it("opens a counter ticket with no table, and several may coexist", async () => {
    const first = await openDirectSaleTicket(context);
    const second = await openDirectSaleTicket(context);

    expect(first.table_id).toBeNull();
    expect(second.id).not.toBe(first.id);
    // The partial unique index deliberately excludes table_id IS NULL: two
    // customers at the counter are two tickets, not a conflict.
    const tables = await listDiningTables(pool, tenant.locationId);
    expect(tables.every((table) => !table.is_occupied)).toBe(true);
  });
});
