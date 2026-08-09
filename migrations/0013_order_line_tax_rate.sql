-- ORD-09: the tax rate each line was charged at, kept on the line.
--
-- DEC-05 requires the receipt to show "le sous-total HT, la TVA et le total
-- TTC **par taux applicable**". The order already stores one aggregate
-- `tax_amount`, which cannot be broken down after the fact: a receipt that
-- re-derived each rate from today's catalog would print a different
-- breakdown the day a rate changes, or the day a product moves to another
-- tax class — for a sale that happened months ago.
--
-- So the rate is snapshotted alongside the unit price, at payment, for the
-- same reason the price is: a receipt has to state what was actually
-- charged, not what would be charged now.
ALTER TABLE order_items
  ADD COLUMN tax_rate_percent DECIMAL(5, 2) CHECK (
    tax_rate_percent IS NULL
    OR (
      tax_rate_percent >= 0
      AND tax_rate_percent <= 100
    )
  );

-- Nullable, and deliberately not backfilled. Lines sold before this
-- migration were charged at a rate nobody recorded; guessing it from the
-- product's current tax class would produce a confident, unverifiable
-- number on a fiscal document. A receipt for such an order shows the total
-- tax the order does hold, and says the per-rate detail is unavailable —
-- the same choice ORD-01 made for the author of pre-canonical orders.
