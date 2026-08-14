-- Phase 5A: a reconcilable till.

-- CASH-03/DEC-11: a cash movement gains a `category` alongside its `type`.
-- `type` carries the sign (IN adds, OUT subtracts); `category` carries the
-- business meaning. Until now two 200 € withdrawals were indistinguishable —
-- consumables bought for the kitchen and the end-of-service emptying of the
-- drawer — and CASH-04 has to tell them apart to avoid double-counting
-- withdrawals in the expected-cash formula. Matching on the free-text
-- `reason` is not an option: it is typed by hand, in whatever words.
--
-- Unlike 0006, this table is NOT empty in existing environments (every
-- opening float since CASH-01 is a row here, and dev/staging databases have
-- real IN/OUT lines). The column is therefore added nullable, backfilled,
-- and only then made NOT NULL — the sequence 0006 had to be repaired for in
-- ORD-01 once a database with data met it.
ALTER TABLE cash_movements ADD COLUMN category VARCHAR(32);

-- Existing rows carry no category information beyond their sign, so they get
-- the honest generic value for that sign rather than a guess. The one
-- exception is OPENING, whose meaning is unambiguous: there is exactly one
-- kind of opening movement, the float itself (CASH-02).
UPDATE cash_movements SET category = 'OPENING_FLOAT' WHERE type = 'OPENING';
UPDATE cash_movements SET category = 'OTHER' WHERE type IN ('IN', 'OUT');

ALTER TABLE cash_movements ALTER COLUMN category SET NOT NULL;

-- The pairing is enforced here, not only in zod: `category` is meaningless
-- without its `type` (an END_OF_SERVICE_WITHDRAWAL that adds money is not a
-- typo, it is a corrupt ledger), and the application is not the only writer —
-- scripts/seed.mjs and future migrations write to this table too.
ALTER TABLE cash_movements
  ADD CONSTRAINT cash_movements_category_check CHECK (
    (type = 'OPENING' AND category = 'OPENING_FLOAT')
    OR (type = 'IN' AND category IN ('FUND_TOPUP', 'OTHER'))
    OR (type = 'OUT' AND category IN ('END_OF_SERVICE_WITHDRAWAL', 'PURCHASE', 'BANK_DEPOSIT', 'OTHER'))
  );

-- CASH-07 filters the day's journal by category, and CASH-04 sums one
-- category apart from the others; both read within a single business day.
CREATE INDEX cash_movements_business_day_category_idx
  ON cash_movements (business_day_id, category);
