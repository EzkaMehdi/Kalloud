-- STK-02: explains every product's current stock_quantity in the ledger
-- STK-01 introduced, for stock that already existed before the ledger did.
--
-- created_by is relaxed to nullable, but only for OPENING_BALANCE: DEC-06's
-- own table describes this type as triggered by "migration ou création",
-- i.e. the one type that can legitimately have no real human actor behind
-- it. Mirrors the existing precedent of audit_events.actor_user_id, already
-- nullable for exactly this kind of system-originated event. Every other
-- movement type still requires a real author — the CHECK below enforces
-- that at the database level, not just by convention.
ALTER TABLE stock_movements ALTER COLUMN created_by DROP NOT NULL;

ALTER TABLE stock_movements
ADD CONSTRAINT stock_movements_author_required_check CHECK (
  type = 'OPENING_BALANCE'
  OR created_by IS NOT NULL
);

-- Pure backfill: only inserts into the ledger, never touches
-- products.stock_quantity. The materialized balance already holds the
-- correct value for every existing product — this statement explains it
-- retroactively, it does not change it. That is what makes "solde
-- avant/après migration identique" true by construction rather than by a
-- test hoping no one adds a stray UPDATE beside it later.
INSERT INTO
  stock_movements (
    location_id,
    product_id,
    quantity,
    type,
    reason,
    created_by,
    reference_type,
    reference_id
  )
SELECT
  location_id,
  id,
  stock_quantity,
  'OPENING_BALANCE',
  'Solde initial migré (STK-02) — stock existant avant la création du ledger',
  NULL,
  NULL,
  NULL
FROM products
WHERE
  stock_quantity <> 0;
