import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { pool } from "../../lib/db";
import {
  createCashMovement,
  getExpectedCash,
  listCashMovements,
  OPENING_FLOAT_CATEGORY,
} from "../../lib/repositories/cash-movements";
import { createProduct, type ProductRow } from "../../lib/repositories/products";
import { closeCurrentBusinessDay, openNewBusinessDay } from "../../lib/services/business-day";
import { refundOrder } from "../../lib/services/refunds";
import { parseOrThrow } from "../../lib/validation/parse";
import { refundOrderSchema } from "../../lib/validation/schemas";
import { createTestTenant, createTestUser, type TestTenant } from "./helpers/fixtures";
import { resetDatabase } from "./helpers/reset-database";
import { sell } from "./helpers/sales";
import type { RequestContext } from "../../lib/context";

/**
 * CASH-03/DEC-11. Most of this ticket's livrable was already true before it
 * (a positive amount, a motive, an author, an establishment, an audit entry,
 * and idempotency against a double-recorded withdrawal): what was missing
 * was the category, and specifically a category CASH-04 can rely on to tell
 * an end-of-service withdrawal apart from any other outflow.
 *
 * The pairing rules themselves are proven at the schema tier
 * (tests/unit/validation.test.ts) and in the database
 * (tests/integration/migrations-legacy-data.test.ts). What is proven here is
 * that the category survives the whole write path, and that the two
 * acceptance clauses which are not about validation — "immuable" and
 * "auditable" — actually hold.
 */

let tenant: TestTenant;
let context: RequestContext;
let coffee: ProductRow;

beforeEach(async () => {
  await resetDatabase(pool);
  tenant = await createTestTenant(pool, "Cash Movement Tenant");
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
  coffee = await createProduct(pool, tenant.locationId, {
    categoryId: null,
    name: "Café",
    price: "10.00",
    stockQuantity: 50,
  });
});

describe("CASH-03: cash movements carry a category", () => {
  it("records the opening float under the one category a client cannot send", async () => {
    const day = await openNewBusinessDay(context, 15_000);

    const [movement] = await listCashMovements(pool, tenant.locationId);
    expect(movement.business_day_id).toBe(day.id);
    expect(movement.type).toBe("OPENING");
    expect(movement.category).toBe(OPENING_FLOAT_CATEGORY);
    // The author and the establishment were already part of the row; the
    // ticket's livrable lists them, so they are asserted rather than assumed.
    expect(movement.created_by).toBe(context.userId);
    expect(movement.location_id).toBe(tenant.locationId);
  });

  it("keeps an end-of-service withdrawal distinguishable from any other outflow", async () => {
    const day = await openNewBusinessDay(context, 15_000);

    await createCashMovement(pool, tenant.locationId, {
      businessDayId: day.id,
      type: "OUT",
      category: "PURCHASE",
      amount: "200.00",
      reason: "Consommables",
      createdBy: context.userId,
    });
    await createCashMovement(pool, tenant.locationId, {
      businessDayId: day.id,
      type: "OUT",
      category: "END_OF_SERVICE_WITHDRAWAL",
      amount: "200.00",
      reason: "Retrait du tiroir",
      createdBy: context.userId,
    });

    // Same sign, same amount, same day: before DEC-11 these two rows were
    // indistinguishable, which is precisely what stops CASH-04 from
    // excluding withdrawals without double-counting them.
    const { rows } = await pool.query<{ category: string; total: string }>(
      `SELECT category, SUM(amount)::TEXT AS total FROM cash_movements
        WHERE location_id = $1 AND type = 'OUT' GROUP BY category ORDER BY category`,
      [tenant.locationId],
    );
    expect(rows).toEqual([
      { category: "END_OF_SERVICE_WITHDRAWAL", total: "200.00" },
      { category: "PURCHASE", total: "200.00" },
    ]);
  });

  it("refuses a category that contradicts the direction, even from the repository", async () => {
    const day = await openNewBusinessDay(context, 0);

    // The repository is below zod: a service calling it directly must still
    // not be able to write an inflow labelled as a withdrawal.
    await expect(
      createCashMovement(pool, tenant.locationId, {
        businessDayId: day.id,
        type: "IN",
        category: "END_OF_SERVICE_WITHDRAWAL",
        amount: "10.00",
        reason: "Incohérent",
        createdBy: context.userId,
      }),
    ).rejects.toThrow(/cash_movements_category_check/);
  });

  /**
   * "Mouvement immuable" (acceptance). There is no update or delete path,
   * and that is a property of the code's surface rather than of any single
   * run — so it is checked the way tests/unit/architecture.test.ts checks
   * this codebase's other structural rules, by reading the module.
   */
  it("exposes no way to modify or delete a recorded movement", () => {
    const source = readFileSync(
      path.join(process.cwd(), "lib/repositories/cash-movements.ts"),
      "utf8",
    );

    expect(source).not.toMatch(/UPDATE\s+cash_movements/i);
    expect(source).not.toMatch(/DELETE\s+FROM\s+cash_movements/i);
  });
});

/**
 * CASH-04: `fond initial + ventes espèces nettes + entrées − sorties`.
 *
 * Every figure below is asserted as an exact amount rather than as a
 * relation between two reads — "tests chiffrés" is the acceptance wording,
 * and a drawer that reconciles "by the same delta both times" is exactly how
 * a formula stays wrong without anyone noticing.
 */
describe("CASH-04: expected cash is one shared formula", () => {
  it("adds the four terms, and reports each of them", async () => {
    const day = await openNewBusinessDay(context, 15_000); // fond 150,00 €
    await sell(context, [{ productId: coffee.id, quantity: 1 }], { paymentMethod: "CASH" });
    await createCashMovement(pool, tenant.locationId, {
      businessDayId: day.id,
      type: "IN",
      category: "FUND_TOPUP",
      amount: "20.00",
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

    // 150,00 + 10,00 + 20,00 − 5,00
    expect(await getExpectedCash(pool, tenant.locationId, day.id)).toEqual({
      opening_cash: "150.00",
      cash_sales: "10.00",
      cash_in: "20.00",
      cash_out: "5.00",
      expected: "175.00",
    });
  });

  it("takes a cash refund back out, and leaves a card refund alone", async () => {
    const day = await openNewBusinessDay(context, 10_000); // fond 100,00 €
    const cashSale = await sell(context, [{ productId: coffee.id, quantity: 2 }], {
      paymentMethod: "CASH",
    });
    const cardSale = await sell(context, [{ productId: coffee.id, quantity: 3 }], {
      paymentMethod: "CARD",
    });
    // The card sale never entered the drawer, so it is absent from the start.
    expect((await getExpectedCash(pool, tenant.locationId, day.id)).expected).toBe("120.00");

    await refundOrder(
      context,
      cashSale.order.id,
      parseOrThrow(refundOrderSchema, { reason: "Client mécontent" }),
    );
    await refundOrder(
      context,
      cardSale.order.id,
      parseOrThrow(refundOrderSchema, { reason: "Erreur de saisie" }),
    );

    const after = await getExpectedCash(pool, tenant.locationId, day.id);
    // Only the 20,00 € handed back in cash leaves the drawer; refunding the
    // card sale changes revenue but not what is in the till.
    expect(after.cash_sales).toBe("0.00");
    expect(after.expected).toBe("100.00");
  });

  it("subtracts an end-of-service withdrawal exactly once", async () => {
    const day = await openNewBusinessDay(context, 15_000);
    await sell(context, [{ productId: coffee.id, quantity: 10 }], { paymentMethod: "CASH" });
    await createCashMovement(pool, tenant.locationId, {
      businessDayId: day.id,
      type: "OUT",
      category: "END_OF_SERVICE_WITHDRAWAL",
      amount: "200.00",
      reason: "Retrait du tiroir",
      createdBy: context.userId,
    });

    // 150,00 + 100,00 − 200,00. Two failure modes are excluded by name:
    // "250.00" is the figure the closing used to produce by ignoring the
    // movement ledger entirely, and "-50.00" is what subtracting the
    // withdrawal twice would give.
    const expected = (await getExpectedCash(pool, tenant.locationId, day.id)).expected;
    expect(expected).toBe("50.00");
    expect(expected).not.toBe("250.00");
    expect(expected).not.toBe("-50.00");
  });

  it("counts the opening float once, though the schema holds it twice", async () => {
    // `business_days.opening_cash` and the `OPENING` movement written beside
    // it (CASH-01) describe the same 150 €. Summing the ledger naively —
    // including OPENING — on top of the day's own column would answer 300.
    const day = await openNewBusinessDay(context, 15_000);

    const result = await getExpectedCash(pool, tenant.locationId, day.id);
    expect(result.opening_cash).toBe("150.00");
    expect(result.cash_in).toBe("0.00");
    expect(result.expected).toBe("150.00");
  });

  it("closes on the very figure the caisse screen was showing", async () => {
    const day = await openNewBusinessDay(context, 15_000);
    await sell(context, [{ productId: coffee.id, quantity: 10 }], { paymentMethod: "CASH" });
    await createCashMovement(pool, tenant.locationId, {
      businessDayId: day.id,
      type: "OUT",
      category: "END_OF_SERVICE_WITHDRAWAL",
      amount: "200.00",
      reason: "Retrait du tiroir",
      createdBy: context.userId,
    });
    const shown = (await getExpectedCash(pool, tenant.locationId, day.id)).expected;

    const { closed } = await closeCurrentBusinessDay(context);

    // The regression this ticket exists for: the closing computed
    // `opening_cash + cash_revenue` and never read the movement ledger, so
    // it wrote 250,00 € against a drawer holding 50,00 € — and the cashier
    // was asked to justify a 200 € shortfall that was their own recorded
    // withdrawal.
    expect(closed.closing_cash).toBe("50.00");
    expect(closed.closing_cash).toBe(shown);
  });
});
