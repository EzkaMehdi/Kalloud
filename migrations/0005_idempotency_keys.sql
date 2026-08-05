-- API-02: server-side idempotency for financial operations.
--
-- DEC-08 fixed the rule this table implements: there is no offline
-- checkout in the MVP, so when the network drops mid-payment the client
-- does not know whether the sale went through. Its only safe move is to
-- retry with the *same* key, and the server must answer with the result it
-- already recorded rather than charging the customer twice.
--
-- Scoped by location like every other business table (SEC-02/SEC-06): two
-- establishments can independently generate the same key value without
-- colliding, and one tenant can never observe another's stored response.

CREATE TABLE idempotency_keys (
  id BIGSERIAL PRIMARY KEY,
  location_id INT NOT NULL REFERENCES locations (id) ON DELETE CASCADE,
  -- The endpoint is part of the identity: the same key replayed against a
  -- different operation is a different operation, not a duplicate.
  endpoint VARCHAR(100) NOT NULL,
  idempotency_key VARCHAR(200) NOT NULL,
  -- SHA-256 of the canonical JSON of the *validated* payload. A key reused
  -- with a different payload is a client bug and is refused (409) instead
  -- of silently returning someone else's result.
  request_hash CHAR(64) NOT NULL,
  status VARCHAR(12) NOT NULL DEFAULT 'IN_PROGRESS' CHECK (status IN ('IN_PROGRESS', 'COMPLETED')),
  response_status INT,
  response_body JSONB,
  user_id INT REFERENCES users (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  -- This is the concurrency control itself, not just a data constraint: two
  -- simultaneous requests race to INSERT, exactly one wins, and the loser is
  -- told the operation is already running or already done.
  UNIQUE (location_id, endpoint, idempotency_key)
);

CREATE INDEX idempotency_keys_expires_at_idx ON idempotency_keys (expires_at);

CREATE INDEX idempotency_keys_location_idx ON idempotency_keys (location_id, created_at DESC);
