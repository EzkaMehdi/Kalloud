import { defineConfig } from "vitest/config";

// Unlike Next.js, Vitest does not load .env files on its own. scripts/ use
// `node --env-file=.env`; this achieves the same thing for the test runner
// itself so DATABASE_URL_TEST reaches tests/integration/global-setup.ts.
try {
  process.loadEnvFile();
} catch {
  // No .env file yet (fresh clone before `cp .env.example .env`): integration
  // tests will fail fast with an explicit "DATABASE_URL_TEST is not set"
  // error rather than silently touching the wrong database.
}

/**
 * Two projects per `FND-04`:
 *  - `unit`: pure functions, no I/O, runs anywhere instantly.
 *  - `integration`: hits a real PostgreSQL instance (see tests/integration/setup.ts).
 * Run everything with `pnpm test`, or a single project with `pnpm test:unit` /
 * `pnpm test:integration`.
 */
export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          include: ["tests/unit/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          environment: "node",
          include: ["tests/integration/**/*.test.ts"],
          env: {
            // lib/db.ts's pool reads DATABASE_URL at import time. Forcing it
            // to the dedicated test database here (rather than in each test
            // file) guarantees every module under test - not just the test
            // file itself - talks to kalloud_test, never local dev data.
            DATABASE_URL: process.env.DATABASE_URL_TEST ?? "",
          },
          globalSetup: ["./tests/integration/global-setup.ts"],
          // Integration tests share one Postgres database and mutate/reset
          // real tables; running them concurrently would race on the same
          // rows, so they run sequentially within a single worker.
          fileParallelism: false,
          hookTimeout: 30_000,
          testTimeout: 30_000,
        },
      },
    ],
  },
});
