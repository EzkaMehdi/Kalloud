-- ORD-02/ORD-03/ORD-05: persistent open tickets, and a floor plan that
-- derives from them instead of carrying its own copy of the truth.

-- ORD-05/DEC-08: optimistic version. Several devices legitimately work the
-- same establishment at once ("pas une session unique verrouillée"), and the
-- decision there was explicit: concurrent edits to one ticket are resolved
-- by an optimistic version check, not a blocking lock — the second writer is
-- refused with a message telling them to reload, never silently overwritten.
-- Every write to a ticket's contents bumps this.
ALTER TABLE orders
  ADD COLUMN version INT NOT NULL DEFAULT 1;

-- ORD-02's acceptance criterion — "une table ne possède au plus qu'un ticket
-- ouvert actif" — as a database guarantee rather than a rule the service
-- layer has to remember. A partial index is what makes that expressible:
-- only OPEN rows participate, so a table can accumulate any number of PAID
-- or CANCELLED orders over a service while never having two live tickets.
-- Direct sales (table_id IS NULL) are excluded: they are not tied to a
-- table, and several may legitimately be open at the counter at once.
CREATE UNIQUE INDEX one_open_order_per_table ON orders (location_id, table_id)
WHERE
  status = 'OPEN'
  AND table_id IS NOT NULL;

-- Reading an establishment's open tickets is the floor plan's hot path once
-- table status is derived from them (ORD-03).
CREATE INDEX orders_open_by_location_idx ON orders (location_id, status)
WHERE
  status = 'OPEN';

-- ORD-03: the floor plan's status stops being stored.
--
-- It was a column the browser wrote optimistically before the order even
-- existed (`PATCH /api/tables/:id` with `{status: "OCCUPIED"}`), which is
-- exactly the "PATCH optimiste sans rollback" the acceptance criterion
-- rules out: a failed or abandoned order left the table occupied forever,
-- with nothing to reconcile it against. Occupancy is now answered by the
-- one fact that defines it — does this table have an open ticket — so
-- "aucune table occupée sans ticket" is true by construction instead of by
-- discipline. Dropping the column is what makes that irreversible; keeping
-- it "in sync" would just be two sources of truth waiting to diverge.
ALTER TABLE dining_tables
  DROP COLUMN status;
