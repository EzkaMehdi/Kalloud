-- Phase 5B: traceable stock.

-- STK-07/DEC-06: "Comptage physique ponctuel : l'utilisateur saisit la
-- quantité comptée pour un produit, le système calcule l'écart avec le solde
-- théorique et génère un mouvement CORRECTION référençant l'inventaire, avec
-- auteur et horodatage."
--
-- The count gets its own table rather than living entirely in the movement
-- it produces, for two reasons the acceptance criterion ("stock avant,
-- compté, différence, auteur et date consultables") makes concrete:
--
--  1. A movement records the *delta*. "Stock avant" and "compté" would have
--     to be reconstructed by replaying the ledger up to that point — derivable,
--     but not consultable.
--  2. A count that matches produces no movement at all: `quantity <> 0`
--     (migrations/0007) forbids a zero-quantity row, and rightly so. Yet
--     "j'ai compté, et le stock était juste" is precisely what an inventory
--     is performed to establish. Without this table that count leaves no
--     trace, and the next person has no way to know it ever happened.
CREATE TABLE stock_counts (
  id BIGSERIAL PRIMARY KEY,
  location_id INT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  product_id INT NOT NULL,
  -- The materialized balance at the moment of counting, captured under the
  -- same row lock the correction is written with, so it cannot be a figure
  -- from before a concurrent sale.
  theoretical_quantity INT NOT NULL,
  counted_quantity INT NOT NULL CHECK (counted_quantity >= 0),
  -- Generated, never written by hand: an écart that disagrees with its own
  -- two operands is the one thing an inventory may not produce.
  difference INT GENERATED ALWAYS AS (counted_quantity - theoretical_quantity) STORED,
  -- NULL when the count matched, since no movement was needed. The reverse
  -- link (movement -> count) is carried by stock_movements.reference_id.
  movement_id BIGINT REFERENCES stock_movements(id),
  note TEXT,
  created_by INT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Composite, like every other product reference in this schema: it makes a
  -- count for another establishment's product unrepresentable rather than
  -- merely unlikely (SEC-08).
  FOREIGN KEY (product_id, location_id) REFERENCES products(id, location_id)
);

-- The read this table exists for: a product's counting history, most recent
-- first (STK-07's "consultables").
CREATE INDEX stock_counts_product_idx ON stock_counts (location_id, product_id, created_at DESC);
