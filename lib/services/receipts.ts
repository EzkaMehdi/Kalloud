import { pool } from "../db";
import { NotFoundError } from "../errors";
import { fromCents, toCents } from "../money";
import { listPaymentsForOrder, type PaymentRow } from "../repositories/payments";
import type { RequestContext } from "../context";

/**
 * ORD-09: the receipt for a settled order.
 *
 * Its acceptance criterion is "justificatif cohérent avec les montants
 * persistés", so nothing here is recomputed from the catalog: line prices,
 * tax rates, totals and payments are all read back from the rows the sale
 * wrote. A receipt that re-derived its numbers would quietly start
 * disagreeing with the order the day a price or a tax rate changed — which
 * is precisely when someone reaches for the receipt.
 */

export interface ReceiptLine {
  product_name: string;
  quantity: number;
  unit_price: string;
  /** Quantity × unit price, before any discount — the price the customer was quoted. */
  line_total: string;
  /** ORD-11: this line's share of the order's discount (migration 0014). */
  line_discount: string;
  /** What this line actually contributed to the total, and what its tax was extracted from. */
  line_net: string;
  tax_rate_percent: string | null;
  notes: string | null;
}

/** DEC-05: "le sous-total HT, la TVA et le total TTC par taux applicable". */
export interface ReceiptTaxBand {
  rate_percent: string;
  subtotal_excluding_tax: string;
  tax: string;
  total_including_tax: string;
}

export interface Receipt {
  order_number: number;
  status: string;
  table_name: string | null;
  created_at: string;
  paid_at: string | null;
  refunded_at: string | null;
  cancelled_at: string | null;
  /** ORD-08: who rang it up. Null only for orders predating ORD-01. */
  served_by: string | null;
  notes: string | null;
  lines: ReceiptLine[];
  subtotal_amount: string | null;
  tax_amount: string | null;
  total_amount: string;
  /** ORD-11: the discount as applied, or null when there was none. */
  discount: { type: string; value: string; amount: string; reason: string } | null;
  /**
   * Empty when the order's lines predate ORD-09 and carry no rate: the
   * receipt then shows `tax_amount` alone rather than inventing a
   * breakdown (see migration 0013).
   */
  tax_bands: ReceiptTaxBand[];
  payments: PaymentRow[];
  /** CHARGE minus REFUND per method — what the customer actually paid, net. */
  net_paid: { cash: string; card: string; total: string };
  refunded_amount: string;
}

interface ReceiptOrderRow {
  id: number;
  order_number: number;
  status: string;
  table_name: string | null;
  created_at: string;
  paid_at: string | null;
  refunded_at: string | null;
  cancelled_at: string | null;
  served_by: string | null;
  notes: string | null;
  subtotal_amount: string | null;
  tax_amount: string | null;
  total_amount: string;
  discount_type: string | null;
  discount_value: string | null;
  discount_amount: string | null;
  discount_reason: string | null;
}

export async function getReceipt(context: RequestContext, orderId: number): Promise<Receipt> {
  const {
    rows: [order],
  } = await pool.query<ReceiptOrderRow>(
    `SELECT o.id, o.order_number, o.status, t.name AS table_name, o.created_at, o.paid_at,
            o.refunded_at, o.cancelled_at, u.name AS served_by, o.notes,
            o.subtotal_amount, o.tax_amount, o.total_amount,
            o.discount_type, o.discount_value, o.discount_amount, o.discount_reason
     FROM orders o
     LEFT JOIN dining_tables t ON t.id = o.table_id AND t.location_id = o.location_id
     LEFT JOIN users u ON u.id = o.created_by
     WHERE o.location_id = $1 AND o.id = $2`,
    [context.locationId, orderId],
  );
  if (!order) {
    throw new NotFoundError("Commande introuvable.");
  }

  const { rows: lines } = await pool.query<ReceiptLine>(
    `SELECT p.name AS product_name, oi.quantity, oi.unit_price,
            (oi.quantity * oi.unit_price)::DECIMAL(10, 2) AS line_total,
            oi.discount_amount AS line_discount,
            (oi.quantity * oi.unit_price - oi.discount_amount)::DECIMAL(10, 2) AS line_net,
            oi.tax_rate_percent, oi.notes
     FROM order_items oi
     JOIN products p ON p.id = oi.product_id
     WHERE oi.order_id = $1
     ORDER BY oi.id`,
    [orderId],
  );

  const payments = await listPaymentsForOrder(pool, context.locationId, orderId);

  return {
    order_number: order.order_number,
    status: order.status,
    table_name: order.table_name,
    created_at: order.created_at,
    paid_at: order.paid_at,
    refunded_at: order.refunded_at,
    cancelled_at: order.cancelled_at,
    served_by: order.served_by,
    notes: order.notes,
    lines,
    subtotal_amount: order.subtotal_amount,
    tax_amount: order.tax_amount,
    total_amount: order.total_amount,
    discount:
      order.discount_type && order.discount_value && order.discount_amount && order.discount_reason
        ? {
            type: order.discount_type,
            value: order.discount_value,
            amount: order.discount_amount,
            reason: order.discount_reason,
          }
        : null,
    tax_bands: buildTaxBands(lines),
    payments,
    net_paid: netPaid(payments),
    refunded_amount: refundedAmount(payments),
  };
}

/**
 * Groups the lines by their recorded rate and extracts the tax from each
 * band's TTC total, with DEC-05's formula and rounding — the same one
 * `extractTaxCents` implements, applied per band rather than per line.
 *
 * Bands are built from lines that have a rate. A line without one (sold
 * before ORD-09) contributes to the order's total but to no band, which is
 * why an order mixing the two would show bands summing to less than
 * `tax_amount`. That only ever happens for orders that predate this
 * migration, and showing nothing beats showing a wrong split.
 */
function buildTaxBands(lines: ReceiptLine[]): ReceiptTaxBand[] {
  const byRate = new Map<string, number>();
  for (const line of lines) {
    if (line.tax_rate_percent === null) continue;
    const rate = Number(line.tax_rate_percent).toFixed(2);
    // ORD-11: the band is built on what was charged, not on the list
    // price. DEC-05 applies the discount before tax, so a band that summed
    // `line_total` would describe amounts nobody paid.
    byRate.set(rate, (byRate.get(rate) ?? 0) + toCents(line.line_net));
  }

  return [...byRate.entries()]
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([rate, totalTtcCents]) => {
      const taxCents = Math.round(totalTtcCents - totalTtcCents / (1 + Number(rate) / 100));
      return {
        rate_percent: rate,
        subtotal_excluding_tax: fromCents(totalTtcCents - taxCents),
        tax: fromCents(taxCents),
        total_including_tax: fromCents(totalTtcCents),
      };
    });
}

function netPaid(payments: PaymentRow[]): { cash: string; card: string; total: string } {
  let cash = 0;
  let card = 0;
  for (const payment of payments) {
    const signed = payment.type === "CHARGE" ? toCents(payment.amount) : -toCents(payment.amount);
    if (payment.method === "CASH") cash += signed;
    else card += signed;
  }
  return { cash: fromCents(cash), card: fromCents(card), total: fromCents(cash + card) };
}

function refundedAmount(payments: PaymentRow[]): string {
  const cents = payments
    .filter((payment) => payment.type === "REFUND")
    .reduce((sum, payment) => sum + toCents(payment.amount), 0);
  return fromCents(cents);
}
