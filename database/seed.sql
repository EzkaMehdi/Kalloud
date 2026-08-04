INSERT INTO categories (name) VALUES ('Chichas'), ('Boissons'), ('Plats/Brunch'), ('Desserts'), ('Packs');

INSERT INTO products (category_id, name, price, stock_quantity, alert_threshold) VALUES
  (1, 'Chicha Signature', 25.00, 12, 5),
  (1, 'Chicha Classique', 20.00, 4, 5),
  (2, 'Thé à la menthe', 4.00, 18, 8),
  (2, 'Mojito passion', 8.00, 0, 4),
  (2, 'Café latte', 5.00, 9, 5),
  (3, 'Brunch Kalloud', 19.00, 3, 3),
  (4, 'Tiramisu maison', 7.00, 7, 4);

INSERT INTO tables_salle (name) VALUES
  ('Table 1'), ('Table 2'), ('Table 3'), ('Table 4'),
  ('Table 5'), ('Table 6'), ('Table 7'), ('Comptoir / Vente directe');

INSERT INTO cash_movements (type, amount, reason) VALUES ('OPENING', 150.00, 'Fond de caisse initial');
