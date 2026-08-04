import { defineConfig, devices } from "@playwright/test";

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
    },
  },
});
