import { withTransaction } from "../db";
import { recordAuditEvent } from "../audit";
import { createProduct, type CreateProductInput, type ProductRow } from "../repositories/products";
import { recordStockMovement } from "../repositories/stock-movements";
import type { RequestContext } from "../context";

/**
 * STK-02: without this, a product created after the ORD-01/STK-01 backfill
 * would immediately reopen the exact gap that migration closed — its
 * initial stock would sit in `products.stock_quantity` with nothing in
 * `stock_movements` to explain it. The product itself is always created at
 * zero (`createProduct`'s repository-level `stockQuantity` stays available
 * for other callers, e.g. a future backfill/import path, but this is the
 * only caller that matters today); the requested starting quantity, if any,
 * is applied afterward as a real `OPENING_BALANCE` movement — the same
 * primitive STK-01 built, reused rather than a second ad-hoc write path
 * (unlike the migration's own backfill, this one has a real actor:
 * whoever is creating the product).
 */
export async function createProductWithInitialStock(
  context: RequestContext,
  input: CreateProductInput,
): Promise<ProductRow> {
  const initialStock = input.stockQuantity ?? 0;

  return withTransaction(async (client) => {
    const product = await createProduct(client, context.locationId, {
      ...input,
      stockQuantity: 0,
    });

    // CFG-02: "changements audités" — creating a product is a catalogue
    // change like any other, and the audit log is where a manager finds out
    // who added it and at what price.
    await recordAuditEvent(client, {
      locationId: context.locationId,
      actorUserId: context.userId,
      action: "product.create",
      targetType: "product",
      targetId: product.id,
      after: { name: product.name, price: product.price, initialStock },
    });

    if (initialStock === 0) {
      return product;
    }

    const { balance } = await recordStockMovement(client, context.locationId, {
      productId: product.id,
      quantity: initialStock,
      type: "OPENING_BALANCE",
      reason: "Stock initial à la création du produit",
      createdBy: context.userId,
    });

    return { ...product, stock_quantity: balance };
  });
}
