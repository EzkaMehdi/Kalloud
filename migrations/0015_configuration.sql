-- Phase 4B: what an owner must be able to configure without SQL.

-- CFG-03: a floor plan is arranged, and tables come and go.
--
-- Deactivation rather than deletion: a table that has served orders is
-- referenced by every one of them (`orders.table_id`), and removing the row
-- would either fail on the foreign key or, worse, take the history with it.
-- "Prix et désactivations conservent l'historique des ventes" (GATE-4B) is
-- the same rule products already follow with `is_active`.
ALTER TABLE dining_tables
  ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT TRUE,
  -- Ordering is the room's own layout, not an alphabetical accident:
  -- "Terrasse 1" sits next to "Terrasse 2", not next to "Table 1".
  ADD COLUMN display_order INT NOT NULL DEFAULT 0;

CREATE INDEX dining_tables_order_idx ON dining_tables (location_id, display_order, id);

-- The floor plan reads active tables constantly; a partial index keeps that
-- path narrow as deactivated ones accumulate over a pilot's lifetime.
CREATE INDEX dining_tables_active_idx ON dining_tables (location_id)
WHERE
  is_active;

-- CFG-02: "son unité" — how a product is counted, for the stock screen to
-- say "3 bouteilles" rather than a bare 3. Nullable: most products are
-- counted in plain units and forcing a word would only invite "unité"
-- everywhere.
ALTER TABLE products
  ADD COLUMN unit VARCHAR(20);

-- CFG-01: the establishment's own name is part of its settings, and lives
-- on `locations`. Nothing to add there — this comment records that the
-- settings screen writes to two tables (locations.name plus
-- location_settings), which is why its service wraps them in one
-- transaction.
