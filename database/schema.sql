CREATE TABLE categories (id SERIAL PRIMARY KEY, name VARCHAR(100) NOT NULL UNIQUE);
CREATE TABLE products (id SERIAL PRIMARY KEY, category_id INT REFERENCES categories(id), name VARCHAR(150) NOT NULL, price DECIMAL(10,2) NOT NULL, stock_quantity INT NOT NULL DEFAULT 0, alert_threshold INT NOT NULL DEFAULT 5, is_active BOOLEAN NOT NULL DEFAULT TRUE);
CREATE TABLE tables_salle (id SERIAL PRIMARY KEY, name VARCHAR(100) NOT NULL UNIQUE, status VARCHAR(10) NOT NULL DEFAULT 'FREE' CHECK (status IN ('FREE','OCCUPIED')));
CREATE TABLE orders (id SERIAL PRIMARY KEY, table_id INT REFERENCES tables_salle(id), status VARCHAR(12) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','COMPLETED','CANCELLED')), payment_method VARCHAR(8) CHECK (payment_method IN ('CASH','CARD','MIXED')), cash_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00, card_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00, total_amount DECIMAL(10,2) NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, closed_at TIMESTAMP);
CREATE TABLE order_items (id SERIAL PRIMARY KEY, order_id INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE, product_id INT NOT NULL REFERENCES products(id), quantity INT NOT NULL CHECK (quantity > 0), unit_price DECIMAL(10,2) NOT NULL, notes TEXT);
CREATE TABLE cash_movements (id SERIAL PRIMARY KEY, type VARCHAR(10) NOT NULL CHECK (type IN ('OPENING','IN','OUT')), amount DECIMAL(10,2) NOT NULL CHECK (amount >= 0), reason VARCHAR(255) NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP);

-- Encaissement atomique : à exécuter dans une transaction côté API.
-- 1. verrouiller products concernés (SELECT ... FOR UPDATE)
-- 2. vérifier stock_quantity >= quantity
-- 3. UPDATE products SET stock_quantity = stock_quantity - order_items.quantity
-- 4. UPDATE orders SET status='COMPLETED', closed_at=NOW(), payment_method=..., cash_amount=..., card_amount=...
-- 5. UPDATE tables_salle SET status='FREE' WHERE id = order.table_id
