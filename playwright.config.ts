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
  /**
   * Capped rather than left to Playwright's default of half the cores (7 on
   * a 14-core machine). The whole suite runs against **one** `next dev`
   * process, which compiles routes on demand; past roughly four concurrent
   * workers it starts dropping requests, and the symptom is a login that
   * silently lands back on `/login` in whichever spec happened to be
   * unlucky. That looked like flakiness in a test and was capacity in the
   * server — the suite crossed the threshold at 128 tests (OPS-08B).
   *
   * Measured rather than guessed: at 7 workers the suite lost 2 to 4 tests a
   * run, at 4 it still lost 1 to 2, and at 2 it went 3 for 3 green. The
   * casualty was always whichever spec asked the most of the server at
   * once — `ticket-persistence`'s two-device test opens two extra browser
   * contexts on top of the workers.
   *
   * The cost is ~25 s (45 s → 1,1 min), which is the right trade for a
   * suite whose job is to be believed. If it ever needs to run faster, the
   * fix is a production build behind it, not more workers against a dev
   * server.
   */
  workers: 2,
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
      // OPS-02: the operations endpoint refuses when no token is set, so
      // the suite needs one to prove both halves — that a caller with the
      // token is served, and that one without it is not.
      OPS_METRICS_TOKEN: "e2e-ops-token",
    },
  },
});
