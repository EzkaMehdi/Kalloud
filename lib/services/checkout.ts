import { withTransaction } from "../db";
import { NotFoundError, ValidationError } from "../errors";
import { recordAuditEvent } from "../audit";
import { getActiveBusinessDay } from "../repositories/business-days";
import { decrementProductStock, lockActiveProductForCheckout } from "../repositories/products";
import { setDiningTableStatus } from "../repositories/tables";
import type { RequestContext } from "../context";

export interface CheckoutItemInput {
  productId: number;
  quantity: number;
  notes?: string | null;
}

export type PaymentMethod = "CASH" | "CARD" | "MIXED";

export interface CheckoutInput {
  tableId: number | null;
  items: CheckoutItemInput[];
  paymentMethod: PaymentMethod;
  cashAmount?: number;
  cardAmount?: number;
}

export interface CheckoutOrderResult {
  id: number;
  table_id: number | null;
  status: string;
  payment_method: PaymentMethod;
  cash_amount: number;
  card_amount: number;
  total_amount: number;
  created_at: string;
  closed_at: string;
}

export interface CheckoutResult {
  order: CheckoutOrderResult;
  total: number;
}

/**
 * Ports the prototype's atomic checkout (lock products, decrement stock,
 * create the order, free the table, all in one transaction) into the new
 * authenticated/scoped architecture. It intentionally keeps the original
 * payment-split behaviour and its known bug (`cardAmount || total`, audit
 * P0-02: a CASH sale is also recorded as CARD revenue) — the canonical,
 * server-validated `cash + card = total` computation is SALE-03 (phase 3).
 * What *is* fixed here, because it is squarely SEC-02/SEC-06/SEC-09 scope:
 * every lookup is scoped to context.locationId, the caller must be
 * authenticated with "orders:create", and the sale is written to the audit
 * log with its actor.
 */
export async function performCheckout(
  context: RequestContext,
  input: CheckoutInput,
): Promise<CheckoutResult> {
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new ValidationError("Ajoutez au moins un article.");
  }
  for (const item of input.items) {
    if (!Number.isInteger(item.productId) || item.productId <= 0) {
      throw new ValidationError("Identifiant de produit invalide.");
    }
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
      throw new ValidationError("Quantité invalide.");
    }
  }

  return withTransaction(async (client) => {
    let total = 0;
    const resolvedItems: {
      productId: number;
      quantity: number;
      unitPrice: number;
      notes: string | null;
    }[] = [];

    for (const item of input.items) {
      const product = await lockActiveProductForCheckout(
        client,
        context.locationId,
        item.productId,
      );
      if (!product) {
        throw new NotFoundError("Produit introuvable.");
      }
      if (product.stockQuantity < item.quantity) {
        throw new ValidationError(`Stock insuffisant pour "${product.name}".`);
      }
      const unitPrice = Number(product.price);
      total += unitPrice * item.quantity;
      resolvedItems.push({
        productId: item.productId,
        quantity: item.quantity,
        unitPrice,
        notes: item.notes ?? null,
      });
    }

    const businessDay = await getActiveBusinessDay(client, context.locationId);
    if (!businessDay) {
      throw new ValidationError("Aucune journée de caisse ouverte.");
    }

    const cashAmount = input.cashAmount ?? 0;
    const cardAmount = input.cardAmount || total; // TODO(SALE-03): reproduces P0-02, see module doc comment.

    const {
      rows: [order],
    } = await client.query<CheckoutOrderResult>(
      `INSERT INTO orders (location_id, table_id, business_day_id, status, payment_method, cash_amount, card_amount, total_amount, closed_at)
       VALUES ($1, $2, $3, 'COMPLETED', $4, $5, $6, $7, now())
       RETURNING id, table_id, status, payment_method, cash_amount, card_amount, total_amount, created_at, closed_at`,
      [
        context.locationId,
        input.tableId,
        businessDay.id,
        input.paymentMethod,
        cashAmount,
        cardAmount,
        total,
      ],
    );

    for (const item of resolvedItems) {
      await client.query(
        "INSERT INTO order_items (order_id, product_id, quantity, unit_price, notes) VALUES ($1, $2, $3, $4, $5)",
        [order.id, item.productId, item.quantity, item.unitPrice, item.notes],
      );
      await decrementProductStock(client, context.locationId, item.productId, item.quantity);
    }

    if (input.tableId) {
      await setDiningTableStatus(client, context.locationId, input.tableId, "FREE");
    }

    await recordAuditEvent(client, {
      locationId: context.locationId,
      actorUserId: context.userId,
      action: "order.checkout",
      targetType: "order",
      targetId: order.id,
      after: { total, paymentMethod: input.paymentMethod, itemCount: resolvedItems.length },
    });

    return { order, total };
  });
}
