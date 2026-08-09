import { beforeEach, describe, expect, it } from "vitest";
import { listAuditEvents } from "../../lib/audit";
import { pool } from "../../lib/db";
import { ConflictError, ValidationError } from "../../lib/errors";
import {
  getActiveBusinessDay,
  getBusinessDaySummary,
  openBusinessDay,
} from "../../lib/repositories/business-days";
import { listOrderHistory } from "../../lib/repositories/orders";
import { createProduct, type ProductRow } from "../../lib/repositories/products";
import { createDiningTable } from "../../lib/repositories/tables";
import { performCheckout } from "../../lib/services/checkout";
import { getReceipt } from "../../lib/services/receipts";
import { refundOrder } from "../../lib/services/refunds";
import {
  cancelTicket,
  openDirectSaleTicket,
  openOrResumeTableTicket,
  saveTicketItems,
  setTicketDiscountAmount,
} from "../../lib/services/tickets";
import { parseOrThrow } from "../../lib/validation/parse";
import {
  checkoutBodySchema,
  refundOrderSchema,
  setDiscountSchema,
} from "../../lib/validation/schemas";
import { createTestTenant, createTestUser, type TestTenant } from "./helpers/fixtures";
import { resetDatabase } from "./helpers/reset-database";
import type { RequestContext } from "../../lib/context";

/**
 * ORD-11, ORD-12 and ORD-14.
 *
 * ORD-14's acceptance criterion is a reconciliation: "remise, TVA, notes,
 * reçu et événements d'audit se réconcilient avec la commande". So the
 * discount tests do not stop at "the total went down" — they check the tax
 * bands still add up to the order's own tax, and that the receipt, the
 * figures and the audit log all tell the same story.
 */

let tenant: TestTenant;
let context: RequestContext;
let coffee: ProductRow;
let meal: ProductRow;

function discount(
  body: { type: "FIXED" | "PERCENT"; value: string; reason: string } | null,
  version: number,
) {
  return parseOrThrow(setDiscountSchema, { version, discount: body });
}

beforeEach(async () => {
  await resetDatabase(pool);
  tenant = await createTestTenant(pool, "Discount Tenant");
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
  await openBusinessDay(pool, tenant.locationId, "0.00");
  coffee = await createProduct(pool, tenant.locationId, {
    categoryId: null,
    name: "Café",
    price: "10.00",
    stockQuantity: 50,
  });
  const {
    rows: [reduced],
  } = await pool.query<{ id: number }>(
    "INSERT INTO tax_classes (location_id, name, rate) VALUES ($1, 'Restauration', 10.00) RETURNING id",
    [tenant.locationId],
  );
  meal = await createProduct(pool, tenant.locationId, {
    categoryId: null,
    name: "Brunch",
    price: "20.00",
    stockQuantity: 50,
  });
  await pool.query("UPDATE products SET tax_class_id = $2 WHERE id = $1", [meal.id, reduced.id]);
});

async function ticketWith(lines: { productId: number; quantity: number }[]) {
  const ticket = await openDirectSaleTicket(context);
  return saveTicketItems(context, ticket.id, { version: ticket.version, items: lines });
}

describe("ORD-11: bounded discounts", () => {
  it("applies a fixed discount to the total actually charged", async () => {
    const ticket = await ticketWith([{ productId: coffee.id, quantity: 2 }]);
    const discounted = await setTicketDiscountAmount(
      context,
      ticket.id,
      discount({ type: "FIXED", value: "5.00", reason: "Geste commercial" }, ticket.version),
    );
    expect(discounted.discount_amount).toBe("5.00");

    const { order } = await performCheckout(
      context,
      parseOrThrow(checkoutBodySchema, { orderId: ticket.id, paymentMethod: "CARD" }),
    );
    expect(order.total_amount).toBe("15.00");
  });

  it("re-resolves a percentage when the ticket's lines change", async () => {
    const ticket = await ticketWith([{ productId: coffee.id, quantity: 2 }]);
    const withDiscount = await setTicketDiscountAmount(
      context,
      ticket.id,
      discount({ type: "PERCENT", value: "10.00", reason: "Habitué" }, ticket.version),
    );
    expect(withDiscount.discount_amount).toBe("2.00");

    // Adding a round must not leave "10 %" frozen at the old 2 €.
    const bigger = await saveTicketItems(context, ticket.id, {
      version: withDiscount.version,
      items: [{ productId: coffee.id, quantity: 5 }],
    });
    expect(bigger.discount_amount).toBe("5.00");
  });

  it("never lets a discount exceed the order", async () => {
    const ticket = await ticketWith([{ productId: coffee.id, quantity: 1 }]);
    const capped = await setTicketDiscountAmount(
      context,
      ticket.id,
      discount({ type: "FIXED", value: "50.00", reason: "Erreur de saisie" }, ticket.version),
    );
    // A negative total is not a sale; ORD-10 is how money goes back.
    expect(capped.discount_amount).toBe("10.00");

    const { order } = await performCheckout(
      context,
      parseOrThrow(checkoutBodySchema, { orderId: ticket.id, paymentMethod: "CASH" }),
    );
    expect(order.total_amount).toBe("0.00");
  });

  it("refuses a discount with no motive, or a percentage above 100", async () => {
    expect(
      setDiscountSchema.safeParse({
        version: 1,
        discount: { type: "FIXED", value: "5.00", reason: "  " },
      }).success,
    ).toBe(false);
    expect(
      setDiscountSchema.safeParse({
        version: 1,
        discount: { type: "PERCENT", value: "150.00", reason: "Trop" },
      }).success,
    ).toBe(false);
  });

  it("can be removed, restoring the full total", async () => {
    const ticket = await ticketWith([{ productId: coffee.id, quantity: 1 }]);
    const withDiscount = await setTicketDiscountAmount(
      context,
      ticket.id,
      discount({ type: "FIXED", value: "3.00", reason: "Remise" }, ticket.version),
    );
    const cleared = await setTicketDiscountAmount(
      context,
      ticket.id,
      discount(null, withDiscount.version),
    );
    expect(cleared.discount_amount).toBeNull();
    expect(cleared.discount_reason).toBeNull();
  });

  it("refuses to discount a ticket that is no longer open", async () => {
    const ticket = await ticketWith([{ productId: coffee.id, quantity: 1 }]);
    await performCheckout(
      context,
      parseOrThrow(checkoutBodySchema, { orderId: ticket.id, paymentMethod: "CARD" }),
    );
    await expect(
      setTicketDiscountAmount(
        context,
        ticket.id,
        discount({ type: "FIXED", value: "1.00", reason: "Trop tard" }, ticket.version + 1),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("ORD-14: a discount reconciles with tax, receipt and audit", () => {
  it("shares the discount across rates so the bands still add up", async () => {
    // 10 € at 20 % and 20 € at 10 %, less a 3 € discount. DEC-05: the
    // discount applies before tax, so each band is taxed on its net share.
    const ticket = await ticketWith([
      { productId: coffee.id, quantity: 1 },
      { productId: meal.id, quantity: 1 },
    ]);
    await setTicketDiscountAmount(
      context,
      ticket.id,
      discount({ type: "FIXED", value: "3.00", reason: "Remise" }, ticket.version),
    );
    const { order } = await performCheckout(
      context,
      parseOrThrow(checkoutBodySchema, { orderId: ticket.id, paymentMethod: "CARD" }),
    );

    expect(order.total_amount).toBe("27.00");

    const receipt = await getReceipt(context, order.id);
    // The bands describe the discounted amounts, not the list prices.
    const bandTotal = receipt.tax_bands.reduce(
      (sum, band) => sum + Number(band.total_including_tax),
      0,
    );
    expect(bandTotal.toFixed(2)).toBe("27.00");
    // And the tax they carry is exactly the tax the order persisted.
    const bandTax = receipt.tax_bands.reduce((sum, band) => sum + Number(band.tax), 0);
    expect(bandTax.toFixed(2)).toBe(receipt.tax_amount);
    // Each band's own HT + TVA = TTC.
    for (const band of receipt.tax_bands) {
      expect((Number(band.subtotal_excluding_tax) + Number(band.tax)).toFixed(2)).toBe(
        band.total_including_tax,
      );
    }
  });

  it("keeps the payment equal to the discounted total, never the list price", async () => {
    const day = await getActiveBusinessDay(pool, tenant.locationId);
    const ticket = await ticketWith([{ productId: coffee.id, quantity: 3 }]);
    await setTicketDiscountAmount(
      context,
      ticket.id,
      discount({ type: "PERCENT", value: "10.00", reason: "Habitué" }, ticket.version),
    );
    await performCheckout(
      context,
      parseOrThrow(checkoutBodySchema, { orderId: ticket.id, paymentMethod: "CASH" }),
    );

    // 30 € less 10 % is 27 €, and that is what the day's figures show.
    const summary = await getBusinessDaySummary(pool, tenant.locationId, day!.id);
    expect(summary.revenue).toBe("27.00");
    expect(summary.cash_revenue).toBe("27.00");
  });

  it("records the discount, its motive and its author in the audit log", async () => {
    const ticket = await ticketWith([{ productId: coffee.id, quantity: 1 }]);
    await setTicketDiscountAmount(
      context,
      ticket.id,
      discount({ type: "FIXED", value: "2.00", reason: "Client fidèle" }, ticket.version),
    );

    const events = await listAuditEvents(pool, tenant.locationId);
    const event = events.find((entry) => entry.action === "order.discount");
    expect(event?.actorUserId).toBe(context.userId);
    expect(event?.after).toMatchObject({ reason: "Client fidèle", amount: "2.00", type: "FIXED" });
  });

  it("reconciles notes, author and amounts on one receipt", async () => {
    const ticket = await openDirectSaleTicket(context);
    const saved = await saveTicketItems(context, ticket.id, {
      version: ticket.version,
      items: [{ productId: coffee.id, quantity: 1, notes: "sans sucre" }],
      notes: "Commande à emporter",
    });
    await setTicketDiscountAmount(
      context,
      ticket.id,
      discount({ type: "FIXED", value: "1.00", reason: "Remise" }, saved.version),
    );
    const { order } = await performCheckout(
      context,
      parseOrThrow(checkoutBodySchema, { orderId: ticket.id, paymentMethod: "CARD" }),
    );

    const receipt = await getReceipt(context, order.id);
    expect(receipt.notes).toBe("Commande à emporter");
    expect(receipt.lines[0].notes).toBe("sans sucre");
    expect(receipt.served_by).toBe("OWNER Test User");
    expect(receipt.total_amount).toBe("9.00");
    // The payment lines net to the same figure the order holds.
    expect(receipt.net_paid.total).toBe("9.00");
  });
});

describe("ORD-12: the order history", () => {
  it("paginates and reports the total", async () => {
    for (let index = 0; index < 5; index += 1) {
      const ticket = await ticketWith([{ productId: coffee.id, quantity: 1 }]);
      await performCheckout(
        context,
        parseOrThrow(checkoutBodySchema, { orderId: ticket.id, paymentMethod: "CARD" }),
      );
    }

    const first = await listOrderHistory(pool, tenant.locationId, { limit: 2, offset: 0 });
    expect(first.orders).toHaveLength(2);
    // A paginator that cannot say how many rows exist can only offer "next".
    expect(first.total).toBe(5);

    const last = await listOrderHistory(pool, tenant.locationId, { limit: 2, offset: 4 });
    expect(last.orders).toHaveLength(1);
    expect(last.total).toBe(5);
  });

  it("filters by status", async () => {
    const paid = await ticketWith([{ productId: coffee.id, quantity: 1 }]);
    await performCheckout(
      context,
      parseOrThrow(checkoutBodySchema, { orderId: paid.id, paymentMethod: "CARD" }),
    );
    const cancelled = await openDirectSaleTicket(context);
    await cancelTicket(context, cancelled.id, { reason: "Abandonné" });
    const refunded = await ticketWith([{ productId: coffee.id, quantity: 1 }]);
    await performCheckout(
      context,
      parseOrThrow(checkoutBodySchema, { orderId: refunded.id, paymentMethod: "CARD" }),
    );
    await refundOrder(context, refunded.id, parseOrThrow(refundOrderSchema, { reason: "Retour" }));

    expect(
      (await listOrderHistory(pool, tenant.locationId, { status: "PAID", limit: 20, offset: 0 }))
        .total,
    ).toBe(1);
    expect(
      (
        await listOrderHistory(pool, tenant.locationId, {
          status: "CANCELLED",
          limit: 20,
          offset: 0,
        })
      ).total,
    ).toBe(1);
    expect(
      (
        await listOrderHistory(pool, tenant.locationId, {
          status: "REFUNDED",
          limit: 20,
          offset: 0,
        })
      ).total,
    ).toBe(1);
  });

  it("never shows an open ticket, whatever the filters", async () => {
    await ticketWith([{ productId: coffee.id, quantity: 1 }]);
    const all = await listOrderHistory(pool, tenant.locationId, { limit: 50, offset: 0 });
    expect(all.total).toBe(0);
  });

  it("carries the author and the discount, so a row needs no second lookup", async () => {
    const ticket = await ticketWith([{ productId: coffee.id, quantity: 1 }]);
    await setTicketDiscountAmount(
      context,
      ticket.id,
      discount({ type: "FIXED", value: "2.00", reason: "Remise" }, ticket.version),
    );
    await performCheckout(
      context,
      parseOrThrow(checkoutBodySchema, { orderId: ticket.id, paymentMethod: "CARD" }),
    );

    const [row] = (await listOrderHistory(pool, tenant.locationId, { limit: 1, offset: 0 })).orders;
    expect(row.created_by_name).toBe("OWNER Test User");
    expect(row.discount_amount).toBe("2.00");
    expect(row.total_amount).toBe("8.00");
  });

  it("filters on when the order was settled, not when it was opened", async () => {
    const ticket = await ticketWith([{ productId: coffee.id, quantity: 1 }]);
    // Opened "yesterday", paid now: a ticket carried across midnight belongs
    // to the day it was paid, which is what a history screen is asking.
    await pool.query("UPDATE orders SET created_at = now() - interval '1 day' WHERE id = $1", [
      ticket.id,
    ]);
    await performCheckout(
      context,
      parseOrThrow(checkoutBodySchema, { orderId: ticket.id, paymentMethod: "CARD" }),
    );

    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const page = await listOrderHistory(pool, tenant.locationId, {
      from: since,
      limit: 20,
      offset: 0,
    });
    expect(page.total).toBe(1);
  });
});

describe("ORD-13: the full life of a ticket", () => {
  it("goes from open to paid to refunded, leaving a trace at every step", async () => {
    const tableId = (await createDiningTable(pool, tenant.locationId, "T1")).id;

    // 1. Opened on a table.
    const { ticket, created } = await openOrResumeTableTicket(context, tableId);
    expect(created).toBe(true);

    // 2. Resumed from another "device" — same ticket, not a second one.
    const resumed = await openOrResumeTableTicket(context, tableId);
    expect(resumed.created).toBe(false);
    expect(resumed.ticket.id).toBe(ticket.id);

    // 3. Filled, discounted, noted.
    const filled = await saveTicketItems(context, ticket.id, {
      version: ticket.version,
      items: [{ productId: coffee.id, quantity: 2 }],
      notes: "Table 1",
    });
    const discounted = await setTicketDiscountAmount(
      context,
      ticket.id,
      discount({ type: "PERCENT", value: "10.00", reason: "Habitué" }, filled.version),
    );
    expect(discounted.total_amount).toBe("20.00");
    expect(discounted.discount_amount).toBe("2.00");

    // 4. Paid — the same row transitions, keeping its number.
    const { order } = await performCheckout(
      context,
      parseOrThrow(checkoutBodySchema, { orderId: ticket.id, paymentMethod: "CASH" }),
    );
    expect(order.id).toBe(ticket.id);
    expect(order.order_number).toBe(ticket.order_number);
    expect(order.total_amount).toBe("18.00");

    // 5. Refunded in full.
    const refund = await refundOrder(
      context,
      order.id,
      parseOrThrow(refundOrderSchema, { reason: "Client mécontent" }),
    );
    expect(refund.status).toBe("REFUNDED");
    expect(refund.netTotal).toBe("0.00");

    // Every step left a trace, with its actor.
    const actions = (await listAuditEvents(pool, tenant.locationId)).map((event) => event.action);
    expect(actions).toEqual(
      expect.arrayContaining(["order.open", "order.discount", "order.checkout", "order.refund"]),
    );

    // And the table is free again, because occupancy is derived (ORD-03).
    const { rows } = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::TEXT AS count FROM orders WHERE location_id = $1 AND status = 'OPEN'",
      [tenant.locationId],
    );
    expect(rows[0].count).toBe("0");
  });

  it("goes from open to cancelled, leaving the table free and nothing charged", async () => {
    const tableId = (await createDiningTable(pool, tenant.locationId, "T2")).id;
    const { ticket } = await openOrResumeTableTicket(context, tableId);
    await saveTicketItems(context, ticket.id, {
      version: ticket.version,
      items: [{ productId: coffee.id, quantity: 1 }],
    });

    await cancelTicket(context, ticket.id, { reason: "Client parti" });

    const day = await getActiveBusinessDay(pool, tenant.locationId);
    const summary = await getBusinessDaySummary(pool, tenant.locationId, day!.id);
    expect(summary.revenue).toBe("0.00");
    // The ticket is not lost — it is in history, marked.
    const history = await listOrderHistory(pool, tenant.locationId, { limit: 20, offset: 0 });
    expect(history.orders[0].status).toBe("CANCELLED");
  });

  it("never leaves a table blocked by a ticket that cannot be reached", async () => {
    const tableId = (await createDiningTable(pool, tenant.locationId, "T3")).id;
    const { ticket } = await openOrResumeTableTicket(context, tableId);

    // Every open ticket is reachable: a table's through its table, a
    // counter's through the counter list (ORD-07). There is no third kind.
    const { rows } = await pool.query<{ id: number; table_id: number | null }>(
      "SELECT id, table_id FROM orders WHERE location_id = $1 AND status = 'OPEN'",
      [tenant.locationId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].table_id).toBe(tableId);
    expect(rows[0].id).toBe(ticket.id);
  });

  it("refuses every transition that DEC-03 does not allow", async () => {
    const ticket = await ticketWith([{ productId: coffee.id, quantity: 1 }]);

    // An open ticket cannot be refunded.
    await expect(
      refundOrder(context, ticket.id, parseOrThrow(refundOrderSchema, { reason: "Non" })),
    ).rejects.toBeInstanceOf(ConflictError);

    await performCheckout(
      context,
      parseOrThrow(checkoutBodySchema, { orderId: ticket.id, paymentMethod: "CARD" }),
    );

    // A paid order cannot be cancelled, nor paid again.
    await expect(cancelTicket(context, ticket.id, { reason: "Non" })).rejects.toBeInstanceOf(
      ConflictError,
    );
    await expect(
      performCheckout(
        context,
        parseOrThrow(checkoutBodySchema, { orderId: ticket.id, paymentMethod: "CARD" }),
      ),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});
