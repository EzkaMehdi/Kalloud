-- ORD-01/DEC-03: replaces the prototype's PENDING/COMPLETED/CANCELLED status
-- with the canonical OPEN/PAID/CANCELLED/REFUNDED lifecycle, and adds the
-- columns the canonical model requires (author, notes, order number, fiscal
-- snapshot placeholders).
--
-- This migration originally assumed `orders` was empty everywhere and added
-- every new column straight as NOT NULL, with no status mapping. That
-- assumption was false: any database that had processed a sale before ORD-01
-- — a developer's own, or the test database after an end-to-end run — held
-- rows that made this migration fail three times over (the status CHECK is
-- violated by 'COMPLETED', and two NOT NULL columns cannot be added without
-- a default to a non-empty table). The runner applies migrations in filename
-- order and stops at the first failure, so a later corrective migration
-- could never have run; the backfill has to live here.
--
-- Transition enforcement (OPEN -> PAID -> REFUNDED, OPEN -> CANCELLED, never
-- backwards) is deliberately NOT a DB trigger: this codebase has none, and
-- the guarantee instead comes from repository functions that will only ever
-- expose specific, named transitions (ORD-02/ORD-06/ORD-10), never a generic
-- "UPDATE orders SET status = ...". The CHECK constraint below only pins the
-- four valid values a row can hold at rest.
ALTER TABLE orders
  DROP CONSTRAINT orders_status_check;

-- Status mapping, before the new CHECK is installed. DEC-03's lifecycle has
-- an exact counterpart for each of the prototype's three values, so nothing
-- here is a judgement call: PENDING was "not yet paid" (OPEN), COMPLETED was
-- "paid" (PAID), and CANCELLED keeps its name and meaning.
UPDATE orders SET status = 'PAID' WHERE status = 'COMPLETED';

UPDATE orders SET status = 'OPEN' WHERE status = 'PENDING';

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
  -- Author. Nullable rather than NOT NULL, and left NULL for pre-ORD-01
  -- rows: the prototype never recorded who rang a sale up, so there is no
  -- honest value to backfill. Attributing those orders to the
  -- establishment's owner would fabricate audit-log evidence about a
  -- person, which is exactly what an audit trail exists to prevent. The
  -- guarantee is kept for every row that matters by the CHECK added below.
  -- Declared here, in the position the pre-fix version of this migration
  -- gave it, so a database reconciled by 0010 and a freshly migrated one
  -- end up with byte-identical schemas rather than merely equivalent ones.
  ADD COLUMN created_by INT REFERENCES users (id),
  ADD COLUMN notes TEXT,
  -- SALE-03 is the server-side computation that will populate these
  -- correctly (subtotal HT + tax extracted per DEC-05). Nullable, not
  -- defaulted to 0: a NULL honestly means "not computed yet", where a 0
  -- would silently look like a real, taxless snapshot (FND-14).
  ADD COLUMN subtotal_amount DECIMAL(10, 2),
  ADD COLUMN tax_amount DECIMAL(10, 2);

-- The rename above moved a cancelled order's timestamp into `paid_at`, where
-- it would claim the order was paid. Put it back under the right name.
UPDATE orders
SET
  cancelled_at = paid_at,
  paid_at = NULL
WHERE
  status = 'CANCELLED'
  AND paid_at IS NOT NULL;

-- Which rows may legitimately have no author, enforced at the database
-- level rather than left to convention — the precedent STK-02 set for
-- OPENING_BALANCE stock movements, where an intrinsic property of the row
-- decides. Here that property is the fiscal snapshot: SALE-03's canonical
-- checkout always writes subtotal_amount and tax_amount, so "no snapshot"
-- identifies precisely the pre-canonical orders, and no order created from
-- now on can lack an author.
ALTER TABLE orders
ADD CONSTRAINT orders_author_required_check CHECK (
  created_by IS NOT NULL
  OR (
    subtotal_amount IS NULL
    AND tax_amount IS NULL
  )
);

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

-- Order numbers are a per-establishment sequence, so existing orders can be
-- numbered after the fact without inventing anything: chronological order is
-- already recorded. Added nullable, backfilled, then made NOT NULL — the
-- column cannot be added as NOT NULL in one step on a table that has rows.
ALTER TABLE orders
  ADD COLUMN order_number INT;

UPDATE orders
SET
  order_number = numbered.row_number
FROM
  (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY
          location_id
        ORDER BY
          created_at,
          id
      ) AS row_number
    FROM orders
  ) AS numbered
WHERE
  orders.id = numbered.id;

-- The counter has to resume above the highest number handed out, or the
-- next real sale would collide with a backfilled one on the UNIQUE below.
INSERT INTO
  order_number_counters (location_id, next_value)
SELECT
  location_id,
  MAX(order_number) + 1
FROM orders
GROUP BY
  location_id;

ALTER TABLE orders
  ALTER COLUMN order_number SET NOT NULL,
  ADD CONSTRAINT orders_location_order_number_unique UNIQUE (location_id, order_number);
