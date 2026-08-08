-- SALE-02/DEC-05: a real payments ledger, separate from orders' inline
-- cash_amount/card_amount/payment_method columns (still present, still
-- used by checkout.ts's known-prototype flow — see the TODO(SALE-03) this
-- migration adds there). A mixed sale becomes two CHARGE rows (one CASH,
-- one CARD) rather than one row with a "MIXED" method: MIXED describes the
-- order's overall payment mix, never a single line's own method, so it is
-- deliberately not a valid value of `payments.method`.
CREATE TABLE payments (
  id SERIAL PRIMARY KEY,
  location_id INT NOT NULL REFERENCES locations (id) ON DELETE CASCADE,
  order_id INT NOT NULL,
  type VARCHAR(6) NOT NULL CHECK (type IN ('CHARGE', 'REFUND')),
  method VARCHAR(4) NOT NULL CHECK (method IN ('CASH', 'CARD')),
  -- Always positive: `type` carries the direction (a REFUND is a positive
  -- amount handed back, not a negative charge), matching how cash_movements
  -- already models IN/OUT with signless amounts plus a type column, rather
  -- than stock_movements' signed quantity — payments has no "solde
  -- matérialisé" to keep consistent with a sign, so there is nothing this
  -- table gains from signing the amount the way STK-01 needed to.
  amount DECIMAL(10, 2) NOT NULL CHECK (amount > 0),
  -- DEC-05: a REFUND is "liée à la commande d'origine" — but SALE-02's own
  -- livrable asks for a "lien de remboursement", and order_id alone would
  -- only say *which sale* was refunded, not *which charge line* (CASH or
  -- CARD, on a mixed sale) it reverses. Required for REFUND, forbidden for
  -- CHARGE — a charge cannot refund anything, only be refunded.
  refunded_payment_id INT,
  CHECK (
    (
      type = 'CHARGE'
      AND refunded_payment_id IS NULL
    )
    OR (
      type = 'REFUND'
      AND refunded_payment_id IS NOT NULL
    )
  ),
  created_by INT NOT NULL REFERENCES users (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, location_id),
  FOREIGN KEY (order_id, location_id) REFERENCES orders (id, location_id),
  FOREIGN KEY (refunded_payment_id, location_id) REFERENCES payments (id, location_id)
);

CREATE INDEX payments_location_id_idx ON payments (location_id);

CREATE INDEX payments_order_id_idx ON payments (order_id);

CREATE INDEX payments_refunded_payment_id_idx ON payments (refunded_payment_id);

-- Backfill: converts any order that already has real payment amounts
-- (cash_amount/card_amount, from the prototype's inline columns) into the
-- equivalent CHARGE rows, so the new model explains the same history the
-- old columns already held — those columns are not dropped or touched.
-- A mixed sale produces up to two rows here, one per non-zero amount.
--
-- Orders with no recorded author are deliberately skipped. Those are the
-- pre-ORD-01 rows that migration left `created_by` NULL for, on the grounds
-- that the prototype never recorded who rang them up (see 0006's comment);
-- `payments.created_by` is NOT NULL, and the two ways to satisfy it here
-- would be to invent an author or to relax the column for every future row
-- as well. Neither is worth it: those orders still carry their own
-- cash_amount/card_amount, so no history is lost — it simply is not
-- restated in a ledger that would have to lie about who took the money.
INSERT INTO
  payments (location_id, order_id, type, method, amount, created_by)
SELECT
  location_id,
  id,
  'CHARGE',
  'CASH',
  cash_amount,
  created_by
FROM orders
WHERE
  status IN ('PAID', 'REFUNDED')
  AND cash_amount > 0
  AND created_by IS NOT NULL
UNION ALL
SELECT
  location_id,
  id,
  'CHARGE',
  'CARD',
  card_amount,
  created_by
FROM orders
WHERE
  status IN ('PAID', 'REFUNDED')
  AND card_amount > 0
  AND created_by IS NOT NULL;
