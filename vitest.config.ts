import { defineConfig } from "vitest/config";

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
