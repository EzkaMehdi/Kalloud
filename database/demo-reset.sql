-- Jeu de données propre pour une démonstration Kalloud.
-- Réinitialise les données de vente et de stock, sans modifier le schéma.
BEGIN;

TRUNCATE TABLE order_items, orders, cash_movements, products, categories, tables_salle, business_days RESTART IDENTITY CASCADE;

INSERT INTO categories (name) VALUES
  ('Chichas'), ('Boissons chaudes'), ('Boissons fraîches'), ('Snacking'), ('Desserts');

INSERT INTO products (category_id, name, price, stock_quantity, alert_threshold) VALUES
  (1, 'Chicha Signature', 25.00, 12, 4),
  (1, 'Chicha Classique', 20.00, 8, 3),
  (2, 'Thé à la menthe', 4.00, 30, 8),
  (3, 'Mojito passion', 8.00, 14, 5),
  (4, 'Brunch Kalloud', 19.00, 6, 2),
  (5, 'Tiramisu maison', 7.00, 7, 3),
  (2, 'Café latte', 5.00, 18, 5),
  (1, 'Tête supplémentaire', 8.00, 6, 2),
  (3, 'Eau minérale', 3.00, 24, 6),
  (4, 'Croque monsieur', 9.50, 10, 3);

INSERT INTO tables_salle (name, status) VALUES
  ('Table 1', 'FREE'), ('Table 2', 'FREE'), ('Table 3', 'FREE'), ('Table 4', 'FREE'),
  ('Table 5', 'FREE'), ('Table 6', 'FREE'), ('Table 7', 'FREE'), ('Comptoir / Vente directe', 'FREE');

INSERT INTO business_days (opening_cash, status) VALUES (150.00, 'OPEN');
INSERT INTO cash_movements (business_day_id, type, amount, reason)
  SELECT id, 'OPENING', 150.00, 'Fond de caisse — ouverture de service' FROM business_days WHERE status = 'OPEN';

-- Historique de démo : il permet d'illustrer les vues mensuelles et annuelles.
INSERT INTO orders (table_id, status, payment_method, cash_amount, card_amount, total_amount, created_at, closed_at) VALUES
  (1, 'COMPLETED', 'CARD', 0.00, 29.00, 29.00, '2025-11-16 20:10:00', '2025-11-16 20:22:00'),
  (2, 'COMPLETED', 'CASH', 37.00, 0.00, 37.00, '2025-12-21 19:05:00', '2025-12-21 19:18:00'),
  (3, 'COMPLETED', 'CARD', 0.00, 48.00, 48.00, '2026-01-15 21:20:00', '2026-01-15 21:35:00'),
  (4, 'COMPLETED', 'MIXED', 20.00, 35.00, 55.00, '2026-06-08 18:30:00', '2026-06-08 18:48:00'),
  (1, 'COMPLETED', 'CARD', 0.00, 33.00, 33.00, '2026-06-19 20:45:00', '2026-06-19 21:02:00'),
  (5, 'COMPLETED', 'CASH', 42.00, 0.00, 42.00, '2026-06-27 22:00:00', '2026-06-27 22:19:00'),
  (2, 'COMPLETED', 'CARD', 0.00, 54.00, 54.00, '2026-07-04 19:40:00', '2026-07-04 19:57:00'),
  (6, 'COMPLETED', 'CASH', 31.00, 0.00, 31.00, '2026-07-11 18:15:00', '2026-07-11 18:29:00'),
  (3, 'COMPLETED', 'CARD', 0.00, 47.00, 47.00, '2026-07-22 21:10:00', '2026-07-22 21:32:00'),
  (7, 'COMPLETED', 'MIXED', 15.00, 24.00, 39.00, '2026-07-29 20:05:00', '2026-07-29 20:17:00'),
  (1, 'COMPLETED', 'CARD', 0.00, 34.00, 34.00, '2026-08-01 19:25:00', '2026-08-01 19:41:00'),
  (4, 'COMPLETED', 'CASH', 28.00, 0.00, 28.00, '2026-08-02 18:50:00', '2026-08-02 19:06:00'),
  (2, 'COMPLETED', 'CARD', 0.00, 51.00, 51.00, '2026-08-03 21:05:00', '2026-08-03 21:23:00');

COMMIT;
