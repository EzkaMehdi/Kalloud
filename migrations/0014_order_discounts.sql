-- ORD-11/DEC-05: bounded discounts.
--
-- "Montant fixe ou pourcentage, motif obligatoire" — the four columns move
-- together or not at all, which the CHECK below enforces rather than
-- leaving to the service layer: a discount amount with no motive is the
-- same class of hole as a cancellation with no motive (ORD-06).
--
-- `discount_amount` is stored even though it is derivable from type+value,
-- because for a PERCENT discount it is *not* derivable after the fact: it
-- was computed against the order's total at the moment it was applied, and
-- recomputing it later against a different total would print a different
-- figure on a receipt for a sale that already happened.
ALTER TABLE orders
  ADD COLUMN discount_type VARCHAR(8) CHECK (discount_type IN ('FIXED', 'PERCENT')),
  ADD COLUMN discount_value DECIMAL(10, 2) CHECK (discount_value IS NULL OR discount_value > 0),
  ADD COLUMN discount_amount DECIMAL(10, 2) CHECK (discount_amount IS NULL OR discount_amount >= 0),
  ADD COLUMN discount_reason TEXT;

ALTER TABLE orders
ADD CONSTRAINT orders_discount_complete_check CHECK (
  (
    discount_type IS NULL
    AND discount_value IS NULL
    AND discount_amount IS NULL
    AND discount_reason IS NULL
  )
  OR (
    discount_type IS NOT NULL
    AND discount_value IS NOT NULL
    AND discount_amount IS NOT NULL
    AND discount_reason IS NOT NULL
    AND length(btrim(discount_reason)) > 0
  )
);

-- DEC-05: "Elle est appliquée avant le calcul de la taxe (recalcul
-- TTC/HT/TVA après remise)". With several tax rates on one order, an
-- order-level discount has to be shared out across the lines before each
-- line's tax can be extracted — otherwise the per-rate breakdown on the
-- receipt (ORD-09) would describe amounts nobody was charged.
--
-- The share each line took is stored rather than recomputed, for the same
-- reason as the rate itself: a receipt states what happened.
ALTER TABLE order_items
  ADD COLUMN discount_amount DECIMAL(10, 2) NOT NULL DEFAULT 0.00 CHECK (discount_amount >= 0);
