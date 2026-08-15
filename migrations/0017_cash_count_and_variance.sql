-- Phase 5A: a reconcilable till.

-- CASH-05/DEC-04: closing a service means counting the drawer and explaining
-- what does not match, not just freezing a calculated figure.
--
-- `closing_cash` is renamed rather than reused. Since CASH-04 it has held the
-- *expected* amount — the result of `fond + ventes espèces + entrées −
-- sorties` — and a column named "closing cash" sitting next to a new
-- "counted cash" would be read as "the cash at closing", which is precisely
-- the other number. The rename keeps the data and its meaning intact and
-- makes the pair self-describing.
ALTER TABLE business_days RENAME COLUMN closing_cash TO expected_cash;

ALTER TABLE business_days
  -- What the person closing actually counted in the drawer. NULL while the
  -- day is open, and NULL for days closed before this migration: those
  -- closes never asked for a count, and inventing one would fabricate a
  -- reconciliation that never happened.
  ADD COLUMN counted_cash DECIMAL(10, 2),
  -- Generated rather than written by the application: the variance is a
  -- definition, not a decision, and a stored column the code maintains by
  -- hand is a column that eventually disagrees with its own inputs.
  ADD COLUMN cash_variance DECIMAL(10, 2)
    GENERATED ALWAYS AS (counted_cash - expected_cash) STORED,
  -- DEC-04: mandatory beyond `location_settings.cash_discrepancy_threshold`.
  -- The threshold is a setting and can change, so the rule is enforced at
  -- write time (CASH-05) rather than as a CHECK that would retroactively
  -- invalidate stored history the day someone lowers it.
  ADD COLUMN variance_reason VARCHAR(255),
  -- The float deliberately left in the drawer for the next service. Recorded
  -- only: it pre-fills the next "Ouvrir le service" and nothing more. It does
  -- not open a day (DEC-04 requires that to stay an explicit act, CASH-02),
  -- and it does not generate a withdrawal movement — that would double-count
  -- against a withdrawal the cashier already recorded by hand, the exact
  -- trap CASH-04 closed.
  ADD COLUMN next_opening_cash DECIMAL(10, 2),
  -- SEC-09: who closed. Pre-existing closed days keep NULL rather than being
  -- attributed to the establishment's owner — the same rule 0006 applied to
  -- pre-ORD-01 orders, for the same reason: an audit trail must not invent
  -- evidence about a person.
  ADD COLUMN closed_by INT REFERENCES users(id);

ALTER TABLE business_days
  ADD CONSTRAINT business_days_counted_cash_check CHECK (counted_cash >= 0),
  ADD CONSTRAINT business_days_next_opening_cash_check CHECK (next_opening_cash >= 0);

-- CASH-05 pre-fills the next opening float from the most recently closed day
-- of the establishment.
CREATE INDEX business_days_location_closed_at_idx
  ON business_days (location_id, closed_at DESC);
