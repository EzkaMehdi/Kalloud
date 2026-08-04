-- CFG-00: business settings an establishment needs before any financial
-- calculation can run (timezone, currency, tax classes, cash discrepancy
-- threshold), per DEC-04/DEC-05.

CREATE TABLE location_settings (
  location_id INT PRIMARY KEY REFERENCES locations (id) ON DELETE CASCADE,
  timezone VARCHAR(64) NOT NULL DEFAULT 'Europe/Paris',
  currency CHAR(3) NOT NULL DEFAULT 'EUR',
  -- Fallback tax rate used when neither a product nor its category carries
  -- a tax_class_id (DEC-05's fallback rule).
  default_tax_rate DECIMAL(5, 2) NOT NULL DEFAULT 20.00 CHECK (
    default_tax_rate >= 0
    AND default_tax_rate <= 100
  ),
  cash_discrepancy_threshold DECIMAL(10, 2) NOT NULL DEFAULT 5.00 CHECK (cash_discrepancy_threshold >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE tax_classes (
  id SERIAL PRIMARY KEY,
  location_id INT NOT NULL REFERENCES locations (id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  rate DECIMAL(5, 2) NOT NULL CHECK (
    rate >= 0
    AND rate <= 100
  ),
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (location_id, name),
  UNIQUE (id, location_id)
);

CREATE INDEX tax_classes_location_id_idx ON tax_classes (location_id);

-- At most one default tax class per location, so the DEC-05 fallback
-- resolution never has to guess between two candidates.
CREATE UNIQUE INDEX tax_classes_one_default_per_location ON tax_classes (location_id)
WHERE
  is_default;
