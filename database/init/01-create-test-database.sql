-- Runs once, only when Postgres initializes a brand new (empty) data
-- directory. Gives integration tests (FND-04/FND-05) a database that is
-- fully separate from local development data, so `pnpm test:integration`
-- can freely migrate/truncate it without ever touching `pnpm dev` data.
CREATE DATABASE kalloud_test;
