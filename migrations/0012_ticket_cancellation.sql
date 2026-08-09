-- ORD-06: cancelling an open ticket, with the motive kept on the row.
--
-- DEC-03 lists CANCELLED as a terminal state, and ORD-06 asks for
-- "confirmation, motif, audit" — the audit event alone would not be enough:
-- an operator reading the order itself must see why it was cancelled,
-- without having to join a separate log. The column is dedicated rather than
-- reusing `notes`, which belongs to the order's own contents (ORD-08) and
-- would conflate "ce que le client a demandé" with "pourquoi la commande a
-- été annulée".
ALTER TABLE orders
  ADD COLUMN cancellation_reason TEXT;

-- Orders already cancelled under the prototype have no recorded motive, and
-- the constraint below would refuse them outright — the same way ORD-01's
-- migration refused pre-existing rows until it was made data-safe. Stating
-- that the reason was never recorded is honest; inventing one would not be,
-- and leaving the column NULL would make this migration fail on exactly the
-- databases that have history worth keeping.
UPDATE orders
SET
  cancellation_reason = 'Motif non enregistré (annulation antérieure à ORD-06)'
WHERE
  status = 'CANCELLED'
  AND cancellation_reason IS NULL;

-- A cancellation without a motive is exactly the "annulation silencieuse"
-- the acceptance criterion rules out, so the database refuses one — and
-- symmetrically refuses a motive on an order that was not cancelled, which
-- would be a leftover from a state the row is no longer in.
ALTER TABLE orders
ADD CONSTRAINT orders_cancellation_reason_check CHECK (
  (
    status = 'CANCELLED'
    AND cancellation_reason IS NOT NULL
    AND length(btrim(cancellation_reason)) > 0
  )
  OR (
    status <> 'CANCELLED'
    AND cancellation_reason IS NULL
  )
);
