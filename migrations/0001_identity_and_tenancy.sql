-- SEC-01: organizations, locations, users and memberships.
-- Also lays the auth tables needed by SEC-03 (sessions, password resets,
-- login attempts) so identity and access ship as one coherent unit.

CREATE TABLE organizations (
  id SERIAL PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- MVP targets one location per organization (DEC-01), but the schema itself
-- does not hard-limit it so post-MVP multi-location support (P2-SAAS-01)
-- does not require another migration.
CREATE TABLE locations (
  id SERIAL PRIMARY KEY,
  organization_id INT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  name VARCHAR(200) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id)
);

CREATE INDEX locations_organization_id_idx ON locations (organization_id);

CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(320) NOT NULL,
  password_hash TEXT NOT NULL,
  name VARCHAR(200) NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Case-insensitive uniqueness without the citext extension, so this
-- migration runs on managed Postgres offerings that do not grant
-- CREATE EXTENSION rights.
CREATE UNIQUE INDEX users_email_unique_idx ON users ((lower(email)));

-- One role per user per organization (DEC-07). location_id is required
-- (not just implied by the org's single location) so the model already
-- supports a user holding different roles at different locations later.
CREATE TABLE memberships (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  organization_id INT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  location_id INT NOT NULL,
  role VARCHAR(10) NOT NULL CHECK (role IN ('OWNER', 'MANAGER', 'CASHIER')),
  status VARCHAR(10) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, organization_id),
  FOREIGN KEY (location_id, organization_id) REFERENCES locations (id, organization_id)
);

CREATE INDEX memberships_user_id_idx ON memberships (user_id);
CREATE INDEX memberships_organization_id_idx ON memberships (organization_id);
CREATE INDEX memberships_location_id_idx ON memberships (location_id);

-- Sessions are stored server-side (not just signed cookies) so logout and
-- "revoke all sessions" (SEC-03) are immediate and do not depend on client
-- cookie expiry. Only a SHA-256 hash of the session token is stored.
CREATE TABLE sessions (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  user_agent TEXT,
  ip_address VARCHAR(64)
);

CREATE UNIQUE INDEX sessions_token_hash_idx ON sessions (token_hash);
CREATE INDEX sessions_user_id_idx ON sessions (user_id);

CREATE TABLE password_reset_tokens (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX password_reset_tokens_token_hash_idx ON password_reset_tokens (token_hash);
CREATE INDEX password_reset_tokens_user_id_idx ON password_reset_tokens (user_id);

-- Backs the brute-force protection required by SEC-03: a sliding-window
-- count of attempts per email/IP is computed from this table.
CREATE TABLE login_attempts (
  id BIGSERIAL PRIMARY KEY,
  email VARCHAR(320) NOT NULL,
  ip_address VARCHAR(64),
  succeeded BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX login_attempts_email_created_idx ON login_attempts ((lower(email)), created_at);
CREATE INDEX login_attempts_ip_created_idx ON login_attempts (ip_address, created_at);
