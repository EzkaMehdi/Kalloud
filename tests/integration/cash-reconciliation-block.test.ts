import { beforeEach, describe, expect, it } from "vitest";
import { pool } from "../../lib/db";
import { closeBusinessDay, openBusinessDay } from "../../lib/repositories/business-days";
import { createCashMovement, getExpectedCash } from "../../lib/repositories/cash-movements";
import { createProduct } from "../../lib/repositories/products";
import { getCashReconciliation } from "../../lib/services/cash-reconciliation";
import { refundOrder } from "../../lib/services/refunds";
import { parseOrThrow } from "../../lib/validation/parse";
import { refundOrderSchema } from "../../lib/validation/schemas";
import { sell } from "./helpers/sales";
import { createTestTenant, createTestUser, type TestTenant } from "./helpers/fixtures";
import { resetDatabase } from "./helpers/reset-database";
import type { RequestContext } from "../../lib/context";

/**
 * BI-09's acceptance criterion, verbatim: "valeurs identiques au détail de
 * clôture, y compris après remboursement espèces." Every figure this block
 * shows is proved against the exact same source `CASH-05`'s own closing
 * modal reads from (`getExpectedCash`), and a cash refund is exercised
 * directly rather than assumed to net correctly.
 */

let tenant: TestTenant;
let context: RequestContext;

beforeEach(async () => {
  await resetDatabase(pool);
  tenant = await createTestTenant(pool, "Reconciliation Tenant");
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

describe("BI-09: before any service has ever been opened", () => {
  it("reports a genuine zero, not a preset figure", async () => {
    const result = await getCashReconciliation(tenant.locationId);

    expect(result.status).toBe("never_opened");
    expect(result.openingCash).toBe("0.00");
    expect(result.cashSales).toBe("0.00");
    expect(result.expected).toBe("0.00");
    expect(result.counted).toBeNull();
    expect(result.variance).toBeNull();
  });
});

describe("BI-09: the open service — identical to CASH-05's own closing detail", () => {
  it("matches getExpectedCash term for term, with nothing yet counted", async () => {
    const day = await openBusinessDay(pool, tenant.locationId, "100.00");
    const product = await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "Café",
      price: "20.00",
      stockQuantity: 10,
    });
    await sell(context, [{ productId: product.id, quantity: 1 }], { paymentMethod: "CASH" });
    await createCashMovement(pool, tenant.locationId, {
      businessDayId: day.id,
      type: "IN",
      category: "FUND_TOPUP",
      amount: "10.00",
      reason: "Appoint",
      createdBy: context.userId,
    });
    await createCashMovement(pool, tenant.locationId, {
      businessDayId: day.id,
      type: "OUT",
      category: "PURCHASE",
      amount: "5.00",
      reason: "Consommables",
      createdBy: context.userId,
    });

    const result = await getCashReconciliation(tenant.locationId);
    const direct = await getExpectedCash(pool, tenant.locationId, day.id);

    expect(result.status).toBe("open");
    expect(result.openingCash).toBe("100.00");
    expect(result.cashSales).toBe("20.00");
    expect(result.cashIn).toBe("10.00");
    expect(result.cashOut).toBe("5.00");
    expect(result.expected).toBe("125.00"); // 100 + 20 + 10 - 5
    expect(result.counted).toBeNull();
    expect(result.variance).toBeNull();

    // Not just correct — the exact same call `CASH-05`'s closing modal
    // makes, term for term, so the two can never quietly disagree.
    expect(result.openingCash).toBe(direct.opening_cash);
    expect(result.cashSales).toBe(direct.cash_sales);
    expect(result.cashIn).toBe(direct.cash_in);
    expect(result.cashOut).toBe(direct.cash_out);
    expect(result.expected).toBe(direct.expected);
  });

  it("nets a cash refund out of cash sales, exactly like the closing detail would", async () => {
    await openBusinessDay(pool, tenant.locationId, "0.00");
    const product = await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "Chicha",
      price: "20.00",
      stockQuantity: 10,
    });
    const sale = await sell(context, [{ productId: product.id, quantity: 1 }], {
      paymentMethod: "CASH",
    });

    let result = await getCashReconciliation(tenant.locationId);
    expect(result.cashSales).toBe("20.00");
    expect(result.expected).toBe("20.00");

    await refundOrder(
      context,
      sale.order.id,
      parseOrThrow(refundOrderSchema, { reason: "Produit renvoyé", amount: "8.00" }),
    );

    result = await getCashReconciliation(tenant.locationId);
    expect(result.cashSales).toBe("12.00"); // 20.00 charged - 8.00 refunded
    expect(result.expected).toBe("12.00");
  });
});

describe("BI-09: the closed service — frozen, internally consistent reconciliation", () => {
  it("reports the exact figures signed off at close, not a live recomputation", async () => {
    const day = await openBusinessDay(pool, tenant.locationId, "50.00");
    const product = await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "Café",
      price: "10.00",
      stockQuantity: 10,
    });
    await sell(context, [{ productId: product.id, quantity: 1 }], { paymentMethod: "CASH" });
    // Expected: 50 + 10 = 60.00. Counted 55: an écart of -5.00.
    await closeBusinessDay(pool, tenant.locationId, day.id, {
      expectedCash: "60.00",
      countedCash: "55.00",
      varianceReason: "Écart constaté à la clôture",
      nextOpeningCash: null,
      closedBy: context.userId,
    });

    const result = await getCashReconciliation(tenant.locationId);

    expect(result.status).toBe("closed");
    expect(result.expected).toBe("60.00");
    expect(result.counted).toBe("55.00");
    expect(result.variance).toBe("-5.00");
    expect(result.varianceReason).toBe("Écart constaté à la clôture");
    expect(result.closedAt).not.toBeNull();
  });

  it("keeps the frozen reconciliation untouched by a cash refund made after the close", async () => {
    const day = await openBusinessDay(pool, tenant.locationId, "0.00");
    const product = await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "Café",
      price: "20.00",
      stockQuantity: 10,
    });
    const sale = await sell(context, [{ productId: product.id, quantity: 1 }], {
      paymentMethod: "CASH",
    });
    await closeBusinessDay(pool, tenant.locationId, day.id, {
      expectedCash: "20.00",
      countedCash: "20.00",
      varianceReason: null,
      nextOpeningCash: null,
      closedBy: context.userId,
    });

    // A cash refund against an order from the already-closed service —
    // ORD-10 allows a refund at any time, regardless of the business day's
    // own status.
    await refundOrder(
      context,
      sale.order.id,
      parseOrThrow(refundOrderSchema, { reason: "Produit renvoyé" }),
    );

    const result = await getCashReconciliation(tenant.locationId);

    // What was actually reconciled at close time is not silently rewritten
    // by something that happened afterwards — `variance` still equals
    // `counted - expected`, both exactly as recorded, not a new
    // "corrected" écart nobody signed off on.
    expect(result.expected).toBe("20.00");
    expect(result.counted).toBe("20.00");
    expect(result.variance).toBe("0.00");
    // The live breakdown, in contrast, does reflect the refund — an
    // honestly different question ("what does the ledger say right now"),
    // not silently forced to match the frozen total.
    expect(result.cashSales).toBe("0.00");
  });
});

describe("BI-09: tenant isolation", () => {
  it("never mixes another establishment's cash movements into the block", async () => {
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
    await openBusinessDay(pool, otherTenant.locationId, "500.00");
    const otherProduct = await createProduct(pool, otherTenant.locationId, {
      categoryId: null,
      name: "Produit d'un autre établissement",
      price: "999.00",
      stockQuantity: 5,
    });
    await sell(otherContext, [{ productId: otherProduct.id, quantity: 1 }], {
      paymentMethod: "CASH",
    });

    const result = await getCashReconciliation(tenant.locationId);

    expect(result.status).toBe("never_opened");
    expect(result.expected).toBe("0.00");
  });
});
