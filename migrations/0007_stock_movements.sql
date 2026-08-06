-- STK-01/DEC-06: the append-only stock ledger. `products.stock_quantity`
-- remains the materialized balance (DEC-06's choice, for fast reads on the
-- caisse/stock grids) — this migration does not touch it — but from here on
-- every write to it must be paired with a row here in the same transaction
-- (lib/repositories/stock-movements.ts::recordStockMovement), so the ledger
-- stays the reconstructible source of truth DEC-06 requires:
--   products.stock_quantity == SUM(stock_movements.quantity) WHERE product_id = X
--
-- Not yet wired to any write path: checkout.ts still calls the prototype's
-- decrementProductStock directly (see the TODO(SALE-03) added there in this
-- same change) and PATCH /api/products/[id]/stock still calls
-- overwriteProductStockQuantity (TODO(STK-04), already flagged before this
-- migration). DEC-06 itself assigns the `SALE` movement's trigger to
-- SALE-03, not STK-01/STK-03 — so that gap is expected, not silent, for the
-- window between this migration and SALE-03.
CREATE TABLE stock_movements (
  id BIGSERIAL PRIMARY KEY,
  location_id INT NOT NULL REFERENCES locations (id) ON DELETE CASCADE,
  product_id INT NOT NULL,
  -- Signed: positive is stock coming in, negative is stock going out. Zero
  -- would mean "a movement that moved nothing", which is not a movement.
  quantity INT NOT NULL CHECK (quantity <> 0),
  type VARCHAR(20) NOT NULL CHECK (
    type IN ('OPENING_BALANCE', 'SALE', 'RECEIPT', 'CORRECTION', 'LOSS', 'RETURN')
  ),
  -- Locks each type to the "sens" DEC-06's table fixes for it, at the
  -- database level: a future caller (STK-03, STK-06...) that gets a sign
  -- backwards is rejected outright instead of silently corrupting the
  -- balance. CORRECTION is deliberately the one type left unconstrained —
  -- DEC-06 allows it to bring a balance up or down, including into the
  -- negative for a documented catch-up correction.
  CONSTRAINT stock_movements_quantity_sign_check CHECK (
    (type = 'OPENING_BALANCE' AND quantity > 0)
    OR (type = 'SALE' AND quantity < 0)
    OR (type = 'RECEIPT' AND quantity > 0)
    OR (type = 'CORRECTION')
    OR (type = 'LOSS' AND quantity < 0)
    OR (type = 'RETURN' AND quantity > 0)
  ),
  -- Required, like cash_movements.reason: DEC-06 lists a motif as one of
  -- the fields every movement carries, not an optional courtesy.
  reason TEXT NOT NULL,
  created_by INT NOT NULL REFERENCES users (id),
  -- Optional link back to the order or inventory count that caused this
  -- movement ("si applicable", DEC-06) — same shape as audit_events'
  -- target_type/target_id rather than a hard FK, because the referenced
  -- table differs by movement type (orders for SALE, a future inventory
  -- table for STK-07's CORRECTION).
  reference_type VARCHAR(50),
  reference_id VARCHAR(100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (product_id, location_id) REFERENCES products (id, location_id)
);

CREATE INDEX stock_movements_location_id_idx ON stock_movements (location_id);

CREATE INDEX stock_movements_product_id_idx ON stock_movements (product_id);

CREATE INDEX stock_movements_created_at_idx ON stock_movements (created_at DESC);

CREATE INDEX stock_movements_reference_idx ON stock_movements (reference_type, reference_id);
