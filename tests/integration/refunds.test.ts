import { beforeEach, describe, expect, it } from "vitest";
import { listAuditEvents } from "../../lib/audit";
import { pool } from "../../lib/db";
import { ConflictError, NotFoundError, ValidationError } from "../../lib/errors";
import {
  getActiveBusinessDay,
  getBusinessDaySummary,
  openBusinessDay,
} from "../../lib/repositories/business-days";
import { getExpectedCash } from "../../lib/repositories/cash-movements";
import { listPaymentsForOrder } from "../../lib/repositories/payments";
import { createProduct, listProducts, type ProductRow } from "../../lib/repositories/products";
import { listStockMovements } from "../../lib/repositories/stock-movements";
import { getReceipt } from "../../lib/services/receipts";
import { refundOrder } from "../../lib/services/refunds";
import { cancelTicket, openDirectSaleTicket, saveTicketItems } from "../../lib/services/tickets";
import { createTestTenant, createTestUser, type TestTenant } from "./helpers/fixtures";
import { resetDatabase } from "./helpers/reset-database";
import { sell } from "./helpers/sales";
import { parseOrThrow } from "../../lib/validation/parse";
import { refundOrderSchema } from "../../lib/validation/schemas";
import type { RequestContext } from "../../lib/context";

/**
 * ORD-08, ORD-09 and ORD-10.
 *
 * The through-line of ORD-10's acceptance criterion — "aucune suppression de
 * vente ; effets sur paiement net, espèces, taxes et stock explicitement
 * compensés" — is that a refund only ever *adds* rows. So these tests check
 * the original charge is still there afterwards, as insistently as they
 * check the refund landed.
 */

let tenant: TestTenant;
let context: RequestContext;
let coffee: ProductRow;
/** The name stored on the users row, which is what the API surfaces. */
const ownerName = "OWNER Test User";

beforeEach(async () => {
  await resetDatabase(pool);
  tenant = await createTestTenant(pool, "Refund Tenant");
  const owner = await createTestUser(pool, tenant, "OWNER");
  context = {
    userId: owner.userId,
    userEmail: owner.email,
    userName: "Amine",
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
    stockQuantity: 20,
  });
});

describe("ORD-08: author and notes", () => {
  it("records who opened a ticket and surfaces the name, not just the id", async () => {
    const ticket = await openDirectSaleTicket(context);
    expect(ticket.created_by).toBe(context.userId);
    // "Le gérant peut identifier l'auteur d'une opération" — an id alone
    // would send them to the database to find out who that is.
    // The name comes from the users row, not from the request context —
    // which is the point: it is the establishment's record of who acted.
    expect(ticket.created_by_name).toBe(ownerName);
  });

  it("persists an order note, and lets it be cleared", async () => {
    const ticket = await openDirectSaleTicket(context);
    const withNote = await saveTicketItems(context, ticket.id, {
      version: ticket.version,
      items: [{ productId: coffee.id, quantity: 1 }],
      notes: "  Sans sucre  ",
    });
    expect(withNote.notes).toBe("Sans sucre");

    // `null` clears; omitting leaves it alone. Both are real intents.
    const untouched = await saveTicketItems(context, ticket.id, {
      version: withNote.version,
      items: [{ productId: coffee.id, quantity: 2 }],
    });
    expect(untouched.notes).toBe("Sans sucre");

    const cleared = await saveTicketItems(context, ticket.id, {
      version: untouched.version,
      items: [{ productId: coffee.id, quantity: 2 }],
      notes: null,
    });
    expect(cleared.notes).toBeNull();
  });

  it("keeps per-line notes through to the receipt", async () => {
    const ticket = await openDirectSaleTicket(context);
    await saveTicketItems(context, ticket.id, {
      version: ticket.version,
      items: [{ productId: coffee.id, quantity: 1, notes: "bien tassé" }],
      notes: "Table pressée",
    });
    const receipt = await getReceipt(context, ticket.id);
    expect(receipt.notes).toBe("Table pressée");
    expect(receipt.lines[0].notes).toBe("bien tassé");
    expect(receipt.served_by).toBe(ownerName);
  });
});

describe("ORD-09: the receipt", () => {
  it("reports the persisted amounts, not a recomputation", async () => {
    const { order } = await sell(context, [{ productId: coffee.id, quantity: 2 }], {
      paymentMethod: "CARD",
    });

    // The product's price changes after the sale. A receipt that priced
    // from the catalog would now print a different total than the order.
    await pool.query("UPDATE products SET price = '99.00' WHERE id = $1", [coffee.id]);

    const receipt = await getReceipt(context, order.id);
    expect(receipt.total_amount).toBe("20.00");
    expect(receipt.lines[0].unit_price).toBe("10.00");
    expect(receipt.lines[0].line_total).toBe("20.00");
    expect(receipt.order_number).toBe(order.order_number);
  });

  it("breaks the tax down by rate, as DEC-05 requires", async () => {
    // Two rates on one order: the establishment default (20%) and a
    // dedicated class (10%).
    const {
      rows: [reduced],
    } = await pool.query<{ id: number }>(
      "INSERT INTO tax_classes (location_id, name, rate) VALUES ($1, 'Restauration', 10.00) RETURNING id",
      [tenant.locationId],
    );
    const meal = await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "Brunch",
      price: "20.00",
      stockQuantity: 10,
    });
    await pool.query("UPDATE products SET tax_class_id = $2 WHERE id = $1", [meal.id, reduced.id]);

    const { order } = await sell(
      context,
      [
        { productId: coffee.id, quantity: 1 },
        { productId: meal.id, quantity: 1 },
      ],
      { paymentMethod: "CARD" },
    );

    const receipt = await getReceipt(context, order.id);
    expect(receipt.tax_bands).toHaveLength(2);
    const [low, high] = receipt.tax_bands;
    expect(low.rate_percent).toBe("10.00");
    expect(low.total_including_tax).toBe("20.00");
    expect(low.tax).toBe("1.82");
    expect(high.rate_percent).toBe("20.00");
    expect(high.total_including_tax).toBe("10.00");
    expect(high.tax).toBe("1.67");

    // The bands must add up to the tax the order itself persisted.
    const bandTax = receipt.tax_bands.reduce((sum, band) => sum + Number(band.tax), 0);
    expect(bandTax.toFixed(2)).toBe(receipt.tax_amount);
  });

  it("lists the payment lines and the net actually collected", async () => {
    const { order } = await sell(context, [{ productId: coffee.id, quantity: 1 }], {
      paymentMethod: "MIXED",
      cashAmount: "4.00",
      cardAmount: "6.00",
    });

    const receipt = await getReceipt(context, order.id);
    expect(receipt.payments).toHaveLength(2);
    expect(receipt.net_paid).toEqual({ cash: "4.00", card: "6.00", total: "10.00" });
    expect(receipt.refunded_amount).toBe("0.00");
  });

  it("refuses to serve another establishment's receipt", async () => {
    const { order } = await sell(context, [{ productId: coffee.id, quantity: 1 }]);
    const other = await createTestTenant(pool, "Other Tenant");
    const otherOwner = await createTestUser(pool, other, "OWNER");

    await expect(
      getReceipt(
        {
          userId: otherOwner.userId,
          userEmail: otherOwner.email,
          userName: "Other",
          organizationId: other.organizationId,
          locationId: other.locationId,
          role: "OWNER",
          sessionId: 2,
        },
        order.id,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("ORD-10: refunding a sale", () => {
  it("adds REFUND lines without touching the original charge", async () => {
    const { order } = await sell(context, [{ productId: coffee.id, quantity: 1 }], {
      paymentMethod: "CARD",
    });
    const before = await listPaymentsForOrder(pool, tenant.locationId, order.id);

    const result = await refundOrder(
      context,
      order.id,
      parseOrThrow(refundOrderSchema, { reason: "Produit renvoyé" }),
    );

    const after = await listPaymentsForOrder(pool, tenant.locationId, order.id);
    // "Aucune suppression de vente": the original CHARGE is byte-identical.
    const originalCharge = after.find((payment) => payment.id === before[0].id);
    expect(originalCharge).toMatchObject({ type: "CHARGE", amount: "10.00" });
    expect(after.filter((payment) => payment.type === "REFUND")).toHaveLength(1);
    expect(result.refunds[0].refunded_payment_id).toBe(before[0].id);
    expect(result.netTotal).toBe("0.00");
  });

  it("moves a fully refunded order to REFUNDED and returns its stock", async () => {
    const { order } = await sell(context, [{ productId: coffee.id, quantity: 3 }], {
      paymentMethod: "CARD",
    });
    const afterSale = await listProducts(pool, tenant.locationId);
    expect(afterSale.find((row) => row.id === coffee.id)?.stock_quantity).toBe(17);

    const result = await refundOrder(
      context,
      order.id,
      parseOrThrow(refundOrderSchema, { reason: "Commande annulée" }),
    );

    expect(result.status).toBe("REFUNDED");
    expect(result.stockReturned).toBe(true);
    const afterRefund = await listProducts(pool, tenant.locationId);
    expect(afterRefund.find((row) => row.id === coffee.id)?.stock_quantity).toBe(20);

    // The ledger explains the movement, not just the materialized column.
    const movements = await listStockMovements(pool, tenant.locationId, coffee.id);
    const returned = movements.find((movement) => movement.type === "RETURN");
    expect(returned?.quantity).toBe(3);
    expect(returned?.reference_id).toBe(String(order.id));
  });

  it("leaves a partially refunded order PAID, with stock untouched", async () => {
    const { order } = await sell(context, [{ productId: coffee.id, quantity: 2 }], {
      paymentMethod: "CARD",
    });

    const result = await refundOrder(
      context,
      order.id,
      parseOrThrow(refundOrderSchema, {
        reason: "Geste commercial",
        amount: "5.00",
      }),
    );

    // DEC-03: only a refund covering the whole balance flips the status.
    expect(result.status).toBe("PAID");
    expect(result.netTotal).toBe("15.00");
    // A partial refund is an amount, not a list of items — nothing says
    // which product came back, so the ledger stays silent rather than guess.
    expect(result.stockReturned).toBe(false);
    const products = await listProducts(pool, tenant.locationId);
    expect(products.find((row) => row.id === coffee.id)?.stock_quantity).toBe(18);
  });

  it("splits a refund across a MIXED sale's charges", async () => {
    const { order } = await sell(context, [{ productId: coffee.id, quantity: 1 }], {
      paymentMethod: "MIXED",
      cashAmount: "4.00",
      cardAmount: "6.00",
    });

    const result = await refundOrder(
      context,
      order.id,
      parseOrThrow(refundOrderSchema, { reason: "Erreur" }),
    );

    // Cash first, then card — each REFUND linked to the charge it reverses.
    expect(result.refunds.map((refund) => [refund.method, refund.amount])).toEqual([
      ["CASH", "4.00"],
      ["CARD", "6.00"],
    ]);
    expect(result.netTotal).toBe("0.00");
  });

  it("refuses to refund more than is left on the order", async () => {
    const { order } = await sell(context, [{ productId: coffee.id, quantity: 1 }]);
    await expect(
      refundOrder(
        context,
        order.id,
        parseOrThrow(refundOrderSchema, { reason: "Trop", amount: "15.00" }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);

    // Nothing partial was written before the refusal.
    const payments = await listPaymentsForOrder(pool, tenant.locationId, order.id);
    expect(payments.filter((payment) => payment.type === "REFUND")).toHaveLength(0);
  });

  it("refuses a second refund once everything is back", async () => {
    const { order } = await sell(context, [{ productId: coffee.id, quantity: 1 }]);
    await refundOrder(context, order.id, parseOrThrow(refundOrderSchema, { reason: "Premier" }));
    await expect(
      refundOrder(context, order.id, parseOrThrow(refundOrderSchema, { reason: "Second" })),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("refuses to refund a ticket that was never paid", async () => {
    const ticket = await openDirectSaleTicket(context);
    await saveTicketItems(context, ticket.id, {
      version: ticket.version,
      items: [{ productId: coffee.id, quantity: 1 }],
    });
    await expect(
      refundOrder(context, ticket.id, parseOrThrow(refundOrderSchema, { reason: "Non" })),
    ).rejects.toBeInstanceOf(ConflictError);

    const cancelled = await openDirectSaleTicket(context);
    await cancelTicket(context, cancelled.id, { reason: "Abandonné" });
    await expect(
      refundOrder(context, cancelled.id, parseOrThrow(refundOrderSchema, { reason: "Non" })),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("writes an audit event with the actor, the motive and the amount", async () => {
    const { order } = await sell(context, [{ productId: coffee.id, quantity: 1 }]);
    await refundOrder(
      context,
      order.id,
      parseOrThrow(refundOrderSchema, { reason: "Client mécontent", amount: "3.00" }),
    );

    const events = await listAuditEvents(pool, tenant.locationId);
    const refundEvent = events.find((event) => event.action === "order.refund");
    expect(refundEvent?.actorUserId).toBe(context.userId);
    expect(refundEvent?.after).toMatchObject({
      reason: "Client mécontent",
      amount: "3.00",
      full: false,
    });
  });
});

describe("ORD-10/DEC-09: refunds reach the figures", () => {
  it("reduces net revenue and the average basket", async () => {
    const day = await getActiveBusinessDay(pool, tenant.locationId);
    const { order } = await sell(context, [{ productId: coffee.id, quantity: 2 }], {
      paymentMethod: "CARD",
    });
    await sell(context, [{ productId: coffee.id, quantity: 1 }], { paymentMethod: "CARD" });

    const before = await getBusinessDaySummary(pool, tenant.locationId, day!.id);
    expect(before.revenue).toBe("30.00");
    expect(before.orders_count).toBe(2);

    await refundOrder(context, order.id, parseOrThrow(refundOrderSchema, { reason: "Retour" }));

    const after = await getBusinessDaySummary(pool, tenant.locationId, day!.id);
    // "CA net = SUM(commandes PAID.total) − SUM(remboursements)" (DEC-09).
    expect(after.revenue).toBe("10.00");
    expect(after.card_revenue).toBe("10.00");
    // The refunded sale still happened — it is counted, at zero.
    expect(after.orders_count).toBe(2);
    expect(after.average_basket).toBe("5.00");
  });

  it("takes a cash refund back out of expected cash", async () => {
    const day = await getActiveBusinessDay(pool, tenant.locationId);
    const { order } = await sell(context, [{ productId: coffee.id, quantity: 1 }], {
      paymentMethod: "CASH",
    });
    expect((await getExpectedCash(pool, tenant.locationId, day!.id)).expected).toBe("10.00");

    await refundOrder(
      context,
      order.id,
      parseOrThrow(refundOrderSchema, { reason: "Remboursé en espèces" }),
    );

    // DEC-09: "les ventes nettes intègrent les remboursements espèces".
    expect((await getExpectedCash(pool, tenant.locationId, day!.id)).expected).toBe("0.00");
  });

  it("shows the refund on the receipt without erasing what was charged", async () => {
    const { order } = await sell(context, [{ productId: coffee.id, quantity: 1 }], {
      paymentMethod: "CARD",
    });
    await refundOrder(
      context,
      order.id,
      parseOrThrow(refundOrderSchema, { reason: "Retour", amount: "4.00" }),
    );

    const receipt = await getReceipt(context, order.id);
    expect(receipt.total_amount).toBe("10.00");
    expect(receipt.refunded_amount).toBe("4.00");
    expect(receipt.net_paid.total).toBe("6.00");
    expect(receipt.payments).toHaveLength(2);
  });
});
