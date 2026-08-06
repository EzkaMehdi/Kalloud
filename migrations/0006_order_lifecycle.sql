-- ORD-01/DEC-03: replaces the prototype's PENDING/COMPLETED/CANCELLED status
-- with the canonical OPEN/PAID/CANCELLED/REFUNDED lifecycle, and adds the
-- columns the canonical model requires (author, notes, order number, fiscal
-- snapshot placeholders). `orders` has zero rows in every environment this
-- migration has run against so far, so every new column below is added
-- directly as NOT NULL where relevant — no backfill step exists because
-- there is nothing to backfill.
--
-- Transition enforcement (OPEN -> PAID -> REFUNDED, OPEN -> CANCELLED, never
-- backwards) is deliberately NOT a DB trigger: this codebase has none, and
-- the guarantee instead comes from repository functions that will only ever
-- expose specific, named transitions (ORD-02/ORD-06/ORD-10), never a generic
-- "UPDATE orders SET status = ...". The CHECK constraint below only pins the
-- four valid values a row can hold at rest.
ALTER TABLE orders
  DROP CONSTRAINT orders_status_check;

ALTER TABLE orders
  ALTER COLUMN status SET DEFAULT 'OPEN',
  ADD CONSTRAINT orders_status_check CHECK (status IN ('OPEN', 'PAID', 'CANCELLED', 'REFUNDED'));

-- `closed_at` meant "the single moment this order stopped being open" under
-- the old two-outcome model. PAID/CANCELLED/REFUNDED are now distinct
-- terminal states that can each happen at a different time (a PAID order
-- can be REFUNDED days later), so one shared column is no longer enough.
ALTER TABLE orders RENAME COLUMN closed_at TO paid_at;

ALTER TABLE orders
  ADD COLUMN cancelled_at TIMESTAMPTZ,
  ADD COLUMN refunded_at TIMESTAMPTZ,
  ADD COLUMN created_by INT NOT NULL REFERENCES users (id),
  ADD COLUMN notes TEXT,
  -- SALE-03 is the server-side computation that will populate these
  -- correctly (subtotal HT + tax extracted per DEC-05). Nullable, not
  -- defaulted to 0: a NULL honestly means "not computed yet", where a 0
  -- would silently look like a real, taxless snapshot (FND-14).
  ADD COLUMN subtotal_amount DECIMAL(10, 2),
  ADD COLUMN tax_amount DECIMAL(10, 2);

-- Per-location counter backing `order_number`. A dedicated table rather
-- than a Postgres SEQUENCE, because a SEQUENCE cannot be scoped per
-- location_id; the UPDATE ... RETURNING used to consume it (added in
-- lib/repositories/orders.ts) is atomic on its own — two concurrent
-- checkouts for the same location serialize on the row, one waits, neither
-- can observe or hand out the same number twice — so no explicit FOR UPDATE
-- or trigger is needed here either.
CREATE TABLE order_number_counters (
  location_id INT PRIMARY KEY REFERENCES locations (id) ON DELETE CASCADE,
  next_value INT NOT NULL DEFAULT 1
);

ALTER TABLE orders
  ADD COLUMN order_number INT NOT NULL,
  ADD CONSTRAINT orders_location_order_number_unique UNIQUE (location_id, order_number);
