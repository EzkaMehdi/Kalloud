CREATE TABLE IF NOT EXISTS business_days (
  id SERIAL PRIMARY KEY,
  opened_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  closed_at TIMESTAMP,
  opening_cash DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  closing_cash DECIMAL(10,2),
  status VARCHAR(10) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED'))
);

ALTER TABLE orders ADD COLUMN IF NOT EXISTS business_day_id INT REFERENCES business_days(id);
ALTER TABLE cash_movements ADD COLUMN IF NOT EXISTS business_day_id INT REFERENCES business_days(id);

CREATE UNIQUE INDEX IF NOT EXISTS one_open_business_day ON business_days ((status)) WHERE status = 'OPEN';
