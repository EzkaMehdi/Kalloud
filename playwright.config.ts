import { defineConfig, devices } from "@playwright/test";

// See vitest.config.ts: makes DATABASE_URL/DATABASE_URL_TEST available to
// test code that seeds fixtures directly (the spawned `next dev` process
// below loads .env itself regardless, via Next.js' own dotenv support).
try {
  process.loadEnvFile();
} catch {
  // No .env file yet; tests that need direct DB access will fail explicitly.
}

const PORT = 3100;
const baseURL = `http://127.0.0.1:${PORT}`;

/**
 * Browser-journey tier of `FND-04`. Runs against a real (Turbopack) dev
 * server on a dedicated port so it never collides with a developer's own
 * `pnpm dev`. The web server command intentionally calls the Next.js CLI
 * directly (not the `predev` hook) so this suite has no hidden dependency
 * on the database bootstrap scripts; tests that need seeded data start
 * their own fixtures in `tests/e2e/fixtures`.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  // Each spec creates isolated tables and products on purpose (see
  // helpers/floor.ts); nothing used to remove them, so local databases grew
  // dozens of "Test table …" rows per run. CI reseeds and never saw it.
  globalTeardown: "./tests/e2e/global-teardown.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: `pnpm exec next dev --port ${PORT}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      PORT: String(PORT),
      // SEC-07's proxy.ts rate-limits /api/auth/* to 30 req/min per IP by
      // default — a real client's ceiling. useCurrentUser() calling
      // /api/auth/session on every protected page mount means this whole
      // suite's own request count scales with test count, not attacker
      // behaviour, and Playwright's requests share one bucket locally
      // (no x-forwarded-for, so proxy.ts's `ip` resolves to the same
      // "unknown" for every test). Raised only for this dedicated e2e
      // server process — dev and production keep the real default.
      AUTH_RATE_LIMIT_MAX: "1000",
    },
  },
});
