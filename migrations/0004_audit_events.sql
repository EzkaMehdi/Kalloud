-- SEC-09: an append-only business audit log. No UPDATE/DELETE grants are
-- issued to the application role in production (OPS-05); the application
-- layer only ever INSERTs, and reads are scoped by location like every
-- other table (SEC-06).

CREATE TABLE audit_events (
  id BIGSERIAL PRIMARY KEY,
  location_id INT NOT NULL REFERENCES locations (id) ON DELETE CASCADE,
  actor_user_id INT REFERENCES users (id),
  action VARCHAR(100) NOT NULL,
  target_type VARCHAR(100) NOT NULL,
  target_id VARCHAR(100),
  before_data JSONB,
  after_data JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX audit_events_location_created_idx ON audit_events (location_id, created_at DESC);

CREATE INDEX audit_events_actor_idx ON audit_events (actor_user_id);

CREATE INDEX audit_events_target_idx ON audit_events (target_type, target_id);
