-- Reconciles databases that applied 0006 before it was made data-safe.
--
-- 0006 originally declared `orders.created_by` as NOT NULL. It now declares
-- it nullable, guarded by `orders_author_required_check`, so that orders
-- predating ORD-01 — whose author the prototype never recorded — can be
-- migrated without inventing one (see that file's comment). Migrations are
-- never re-run once recorded in schema_migrations, so a database that
-- already applied the original 0006 would otherwise keep the old shape
-- forever while a fresh clone got the new one: same migration id, two
-- different schemas.
--
-- Written to be a no-op on databases that got the corrected 0006, so both
-- paths converge on exactly one schema:
--   * DROP NOT NULL on an already-nullable column succeeds and changes
--     nothing;
--   * the constraint is only added when absent.
-- There is no data change here at all — only the shape of the guarantee.
ALTER TABLE orders
  ALTER COLUMN created_by DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orders_author_required_check'
  ) THEN
    ALTER TABLE orders
      ADD CONSTRAINT orders_author_required_check CHECK (
        created_by IS NOT NULL
        OR (
          subtotal_amount IS NULL
          AND tax_amount IS NULL
        )
      );
  END IF;
END
$$;
