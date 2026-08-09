import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { pool } from "../../lib/db";
import { openBusinessDay } from "../../lib/repositories/business-days";
import {
  getNetPaymentsForOrder,
  recordCharge,
  recordRefund,
} from "../../lib/repositories/payments";
import { createTestTenant, createTestUser, type TestTenant } from "./helpers/fixtures";
import { resetDatabase } from "./helpers/reset-database";

/**
 * SALE-02's acceptance criterion, verbatim: "contraintes monétaires ;
 * charges nettes vérifiables ; migration des données de démo." Each is
 * proved directly below rather than assumed from the schema compiling.
 */

let tenant: TestTenant;
let userId: number;
let orderId: number;

// Only the backfill INSERT ... SELECT ... UNION ALL ... at the end of the
// migration is re-run here — the CREATE TABLE/INDEX statements already ran
// once via global-setup and are not repeatable. Same technique as
// tests/integration/stock-opening-balance.test.ts, for the same reason:
// migrations apply before any test fixture exists, so this is the only way
// to prove the backfill logic against a non-empty scenario.
const backfillSql = readFileSync(join(process.cwd(), "migrations", "0009_payments.sql"), "utf8")
  .split("-- Backfill:")[1]
  .split("INSERT INTO")[1];
const backfillInsertSql = `INSERT INTO${backfillSql}`;

beforeEach(async () => {
  await resetDatabase(pool);
  tenant = await createTestTenant(pool, "Payments Tenant");
  const owner = await createTestUser(pool, tenant, "OWNER");
  userId = owner.userId;

  const businessDay = await openBusinessDay(pool, tenant.locationId, "0.00");
  const {
    rows: [order],
  } = await pool.query<{ id: number }>(
    `INSERT INTO orders (location_id, business_day_id, order_number, created_by, status, total_amount, paid_at)
     VALUES ($1, $2, 1, $3, 'PAID', 20.00, now())
     RETURNING id`,
    [tenant.locationId, businessDay.id, userId],
  );
  orderId = order.id;
});

describe("SALE-02: monetary constraints", () => {
  it("accepts a CHARGE with no refund link", async () => {
    const payment = await recordCharge(pool, tenant.locationId, {
      orderId,
      method: "CASH",
      amount: "20.00",
      createdBy: userId,
    });
    expect(payment.type).toBe("CHARGE");
    expect(payment.refunded_payment_id).toBeNull();
  });

  it("rejects a CHARGE that carries a refund link", async () => {
    await expect(
      pool.query(
        `INSERT INTO payments (location_id, order_id, type, method, amount, refunded_payment_id, created_by)
         VALUES ($1, $2, 'CHARGE', 'CASH', 20.00, 999, $3)`,
        [tenant.locationId, orderId, userId],
      ),
    ).rejects.toThrow();
  });

  it("rejects a REFUND with no refund link", async () => {
    await expect(
      pool.query(
        `INSERT INTO payments (location_id, order_id, type, method, amount, created_by)
         VALUES ($1, $2, 'REFUND', 'CASH', 5.00, $3)`,
        [tenant.locationId, orderId, userId],
      ),
    ).rejects.toThrow();
  });

  it("rejects a zero or negative amount", async () => {
    await expect(
      pool.query(
        `INSERT INTO payments (location_id, order_id, type, method, amount, created_by)
         VALUES ($1, $2, 'CHARGE', 'CASH', 0.00, $3)`,
        [tenant.locationId, orderId, userId],
      ),
    ).rejects.toThrow();
  });

  it("rejects MIXED as a payment line method (it is an order-level concept, not a line's)", async () => {
    await expect(
      pool.query(
        `INSERT INTO payments (location_id, order_id, type, method, amount, created_by)
         VALUES ($1, $2, 'CHARGE', 'MIXED', 20.00, $3)`,
        [tenant.locationId, orderId, userId],
      ),
    ).rejects.toThrow();
  });

  it("refuses a refund link to a payment from another establishment", async () => {
    const otherTenant = await createTestTenant(pool, "Other Payments Tenant");
    const otherOwner = await createTestUser(pool, otherTenant, "OWNER");
    const otherDay = await openBusinessDay(pool, otherTenant.locationId, "0.00");
    const {
      rows: [otherOrder],
    } = await pool.query<{ id: number }>(
      `INSERT INTO orders (location_id, business_day_id, order_number, created_by, status, total_amount, paid_at)
       VALUES ($1, $2, 1, $3, 'PAID', 10.00, now())
       RETURNING id`,
      [otherTenant.locationId, otherDay.id, otherOwner.userId],
    );
    const otherCharge = await recordCharge(pool, otherTenant.locationId, {
      orderId: otherOrder.id,
      method: "CASH",
      amount: "10.00",
      createdBy: otherOwner.userId,
    });

    await expect(
      recordRefund(pool, tenant.locationId, {
        orderId,
        refundedPaymentId: otherCharge.id,
        method: "CASH",
        amount: "5.00",
        createdBy: userId,
      }),
    ).rejects.toThrow();
  });
});

describe("SALE-02: net charges are verifiable", () => {
  it("nets a CHARGE alone to its own amount", async () => {
    await recordCharge(pool, tenant.locationId, {
      orderId,
      method: "CASH",
      amount: "20.00",
      createdBy: userId,
    });
    const net = await getNetPaymentsForOrder(pool, tenant.locationId, orderId);
    expect(net.cash).toBe("20.00");
    expect(net.card).toBe("0.00");
  });

  it("subtracts a REFUND from its CHARGE, never touching or removing the CHARGE row", async () => {
    const charge = await recordCharge(pool, tenant.locationId, {
      orderId,
      method: "CASH",
      amount: "20.00",
      createdBy: userId,
    });
    await recordRefund(pool, tenant.locationId, {
      orderId,
      refundedPaymentId: charge.id,
      method: "CASH",
      amount: "8.00",
      createdBy: userId,
    });

    const net = await getNetPaymentsForOrder(pool, tenant.locationId, orderId);
    expect(net.cash).toBe("12.00");

    const { rows } = await pool.query("SELECT type, amount FROM payments WHERE id = $1", [
      charge.id,
    ]);
    expect(rows[0]).toMatchObject({ type: "CHARGE", amount: "20.00" });
  });

  it("nets CASH and CARD independently on a mixed sale", async () => {
    const cashCharge = await recordCharge(pool, tenant.locationId, {
      orderId,
      method: "CASH",
      amount: "12.00",
      createdBy: userId,
    });
    await recordCharge(pool, tenant.locationId, {
      orderId,
      method: "CARD",
      amount: "8.00",
      createdBy: userId,
    });
    await recordRefund(pool, tenant.locationId, {
      orderId,
      refundedPaymentId: cashCharge.id,
      method: "CASH",
      amount: "2.00",
      createdBy: userId,
    });

    const net = await getNetPaymentsForOrder(pool, tenant.locationId, orderId);
    expect(net.cash).toBe("10.00");
    expect(net.card).toBe("8.00");
  });
});

describe("SALE-02: backfilling existing orders' inline payment columns", () => {
  it("converts a pre-existing CARD-only order into one matching CHARGE row", async () => {
    await pool.query("UPDATE orders SET cash_amount = 0.00, card_amount = 20.00 WHERE id = $1", [
      orderId,
    ]);

    await pool.query(backfillInsertSql);

    const { rows } = await pool.query(
      "SELECT type, method, amount, created_by FROM payments WHERE order_id = $1",
      [orderId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: "CHARGE", method: "CARD", amount: "20.00" });
    expect(rows[0].created_by).toBe(userId);
  });

  it("converts a pre-existing MIXED order into two CHARGE rows, one per non-zero amount", async () => {
    await pool.query("UPDATE orders SET cash_amount = 5.00, card_amount = 15.00 WHERE id = $1", [
      orderId,
    ]);

    await pool.query(backfillInsertSql);

    const { rows } = await pool.query(
      "SELECT method, amount FROM payments WHERE order_id = $1 ORDER BY method",
      [orderId],
    );
    expect(rows).toEqual([
      { method: "CARD", amount: "15.00" },
      { method: "CASH", amount: "5.00" },
    ]);
  });

  it("does not touch orders.cash_amount/card_amount — only explains them", async () => {
    await pool.query("UPDATE orders SET cash_amount = 5.00, card_amount = 15.00 WHERE id = $1", [
      orderId,
    ]);

    await pool.query(backfillInsertSql);

    const { rows } = await pool.query("SELECT cash_amount, card_amount FROM orders WHERE id = $1", [
      orderId,
    ]);
    expect(rows[0]).toMatchObject({ cash_amount: "5.00", card_amount: "15.00" });
  });

  it("skips a CANCELLED order — it never had a real charge to explain", async () => {
    // ORD-06 made a motive mandatory on any cancelled order (migration
    // 0012), so this fixture supplies one — the constraint refuses a
    // cancellation without it, which is the whole point of "aucune
    // annulation silencieuse".
    await pool.query(
      `UPDATE orders
       SET status = 'CANCELLED', cash_amount = 20.00, paid_at = NULL, cancelled_at = now(),
           cancellation_reason = 'Test fixture'
       WHERE id = $1`,
      [orderId],
    );

    await pool.query(backfillInsertSql);

    const { rows } = await pool.query("SELECT * FROM payments WHERE order_id = $1", [orderId]);
    expect(rows).toHaveLength(0);
  });
});
