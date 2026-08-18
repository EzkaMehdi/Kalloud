-- BI-02: "performances mesurées" — the four new history queries this task
-- adds (ventes, paiements, caisse, stock) each filter on `location_id` and
-- a time range, then sort on that same time column. Each existing index on
-- these tables covers only one of the two columns on its own
-- (`payments_location_id_idx`, `cash_movements_location_id_idx`,
-- `stock_movements_location_id_idx`/`stock_movements_created_at_idx`
-- separately) — usable via a bitmap AND, but not as directly as a compound
-- index built for exactly this access pattern: scope to one establishment,
-- then walk its rows newest-first.
--
-- `orders (location_id, status, paid_at DESC)` is new for the same reason,
-- for `listSoldItems`'s join root: it reads PAID/REFUNDED orders in a date
-- range for one establishment before ever touching `order_items`.
-- `orders_created_at_idx` (0003) sorts by `created_at`, not `paid_at`, and
-- carries no status — a ticket still `OPEN` would otherwise cost a look at
-- every row in range to exclude.
CREATE INDEX orders_location_status_paid_idx ON orders (location_id, status, paid_at DESC);

CREATE INDEX payments_location_created_idx ON payments (location_id, created_at DESC);

CREATE INDEX cash_movements_location_created_idx ON cash_movements (location_id, created_at DESC);

CREATE INDEX stock_movements_location_created_idx ON stock_movements (location_id, created_at DESC);
