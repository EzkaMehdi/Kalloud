-- SEC-02: every business table carries location_id so no query can read or
-- write across establishments without going through a scoped repository
-- (SEC-06). Table names follow the canonical entity names from the tasks.md
-- data model (section 4).
--
-- The order lifecycle intentionally keeps the prototype's PENDING/COMPLETED/
-- CANCELLED status and inline payment columns: the canonical OPEN/PAID/
-- CANCELLED/REFUNDED model with a separate payments ledger is DEC-03/ORD-01/
-- SALE-02, scoped to phase 3, not this migration.

CREATE TABLE categories (
  id SERIAL PRIMARY KEY,
  location_id INT NOT NULL REFERENCES locations (id) ON DELETE CASCADE,
  tax_class_id INT REFERENCES tax_classes (id) ON DELETE SET NULL,
  name VARCHAR(100) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (location_id, name),
  UNIQUE (id, location_id),
  FOREIGN KEY (tax_class_id, location_id) REFERENCES tax_classes (id, location_id)
);

CREATE INDEX categories_location_id_idx ON categories (location_id);

CREATE TABLE products (
  id SERIAL PRIMARY KEY,
  location_id INT NOT NULL REFERENCES locations (id) ON DELETE CASCADE,
  category_id INT,
  tax_class_id INT REFERENCES tax_classes (id) ON DELETE SET NULL,
  name VARCHAR(150) NOT NULL,
  price DECIMAL(10, 2) NOT NULL CHECK (price >= 0),
  stock_quantity INT NOT NULL DEFAULT 0,
  alert_threshold INT NOT NULL DEFAULT 5 CHECK (alert_threshold >= 0),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, location_id),
  FOREIGN KEY (category_id, location_id) REFERENCES categories (id, location_id),
  FOREIGN KEY (tax_class_id, location_id) REFERENCES tax_classes (id, location_id)
);

CREATE INDEX products_location_id_idx ON products (location_id);

CREATE INDEX products_category_id_idx ON products (category_id);

CREATE TABLE dining_tables (
  id SERIAL PRIMARY KEY,
  location_id INT NOT NULL REFERENCES locations (id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'FREE' CHECK (status IN ('FREE', 'OCCUPIED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (location_id, name),
  UNIQUE (id, location_id)
);

CREATE INDEX dining_tables_location_id_idx ON dining_tables (location_id);

CREATE TABLE business_days (
  id SERIAL PRIMARY KEY,
  location_id INT NOT NULL REFERENCES locations (id) ON DELETE CASCADE,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ,
  opening_cash DECIMAL(10, 2) NOT NULL DEFAULT 0.00 CHECK (opening_cash >= 0),
  closing_cash DECIMAL(10, 2),
  status VARCHAR(10) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
  UNIQUE (id, location_id)
);

CREATE INDEX business_days_location_id_idx ON business_days (location_id);

-- DEC-04: at most one open business day (service) per establishment.
CREATE UNIQUE INDEX one_open_business_day_per_location ON business_days (location_id)
WHERE
  status = 'OPEN';

CREATE TABLE orders (
  id SERIAL PRIMARY KEY,
  location_id INT NOT NULL REFERENCES locations (id) ON DELETE CASCADE,
  business_day_id INT,
  table_id INT,
  status VARCHAR(12) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'COMPLETED', 'CANCELLED')),
  payment_method VARCHAR(8) CHECK (payment_method IN ('CASH', 'CARD', 'MIXED')),
  cash_amount DECIMAL(10, 2) NOT NULL DEFAULT 0.00 CHECK (cash_amount >= 0),
  card_amount DECIMAL(10, 2) NOT NULL DEFAULT 0.00 CHECK (card_amount >= 0),
  total_amount DECIMAL(10, 2) NOT NULL CHECK (total_amount >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ,
  UNIQUE (id, location_id),
  FOREIGN KEY (business_day_id, location_id) REFERENCES business_days (id, location_id),
  FOREIGN KEY (table_id, location_id) REFERENCES dining_tables (id, location_id)
);

CREATE INDEX orders_location_id_idx ON orders (location_id);

CREATE INDEX orders_business_day_id_idx ON orders (business_day_id);

CREATE INDEX orders_table_id_idx ON orders (table_id);

CREATE INDEX orders_created_at_idx ON orders (created_at DESC);

CREATE TABLE order_items (
  id SERIAL PRIMARY KEY,
  order_id INT NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  product_id INT NOT NULL REFERENCES products (id),
  quantity INT NOT NULL CHECK (quantity > 0),
  unit_price DECIMAL(10, 2) NOT NULL CHECK (unit_price >= 0),
  notes TEXT
);

CREATE INDEX order_items_order_id_idx ON order_items (order_id);

CREATE INDEX order_items_product_id_idx ON order_items (product_id);

CREATE TABLE cash_movements (
  id SERIAL PRIMARY KEY,
  location_id INT NOT NULL REFERENCES locations (id) ON DELETE CASCADE,
  business_day_id INT,
  type VARCHAR(10) NOT NULL CHECK (type IN ('OPENING', 'IN', 'OUT')),
  amount DECIMAL(10, 2) NOT NULL CHECK (amount >= 0),
  reason VARCHAR(255) NOT NULL,
  created_by INT NOT NULL REFERENCES users (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_day_id, location_id) REFERENCES business_days (id, location_id)
);

CREATE INDEX cash_movements_location_id_idx ON cash_movements (location_id);

CREATE INDEX cash_movements_business_day_id_idx ON cash_movements (business_day_id);
