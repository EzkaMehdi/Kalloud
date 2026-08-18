import { expect, test } from "@playwright/test";

/**
 * Exercises the real login flow against the seeded dev tenant (scripts/seed.mjs)
 * end-to-end: form -> session cookie -> authenticated page -> role-based nav
 * -> logout. Requires the dev database to be migrated and seeded, which
 * `pnpm predev`/`pnpm setup` already guarantee for local development.
 */
test.describe("authentication (SEC-03) and role-based navigation (SEC-05)", () => {
  test("an owner can log in, see the real floor plan, and log out", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Adresse e-mail").fill("owner@kalloud.test");
    await page.getByLabel("Mot de passe").fill("Kalloud123!");
    await page.getByRole("button", { name: /se connecter/i }).click();

    await expect(page).toHaveURL(/\/caisse$/);
    await expect(page.getByRole("heading", { name: "La caisse" })).toBeVisible();
    // Seeded tables (scripts/seed.mjs): real data, not the old hardcoded fallback.
    await expect(page.getByRole("button", { name: /table 1/i })).toBeVisible();

    // OWNER has dashboard:view (DEC-07), so the Bilan link is visible.
    await expect(page.getByRole("navigation").getByRole("link", { name: /bilan/i })).toBeVisible();

    await page.getByRole("button", { name: "Se déconnecter" }).click();
    await expect(page).toHaveURL(/\/login/);
  });

  test("a cashier does not see the Bilan link and is refused the dashboard API", async ({
    page,
  }) => {
    await page.goto("/login");
    await page.getByLabel("Adresse e-mail").fill("cashier@kalloud.test");
    await page.getByLabel("Mot de passe").fill("Kalloud123!");
    await page.getByRole("button", { name: /se connecter/i }).click();

    await expect(page).toHaveURL(/\/caisse$/);
    await expect(page.getByRole("navigation").getByRole("link", { name: /bilan/i })).toHaveCount(0);

    const response = await page.request.get("/api/dashboard");
    expect(response.status()).toBe(403);

    // BI-02: the four history queries are reserved the same way, for the
    // same reason (Phase 6 cockpit reporting, not day-to-day cashier work).
    for (const path of [
      "/api/sales",
      "/api/payments",
      "/api/cash-movements/history",
      "/api/stock-movements",
    ]) {
      const historyResponse = await page.request.get(path);
      expect(historyResponse.status(), path).toBe(403);
    }
  });

  test("an invalid password shows an inline, accessible error without navigating away", async ({
    page,
  }) => {
    await page.goto("/login");
    await page.getByLabel("Adresse e-mail").fill("owner@kalloud.test");
    await page.getByLabel("Mot de passe").fill("WrongPassword1!");
    await page.getByRole("button", { name: /se connecter/i }).click();

    // The page also has an always-present (empty) Next.js route-announcer
    // with role="alert"; scope to our own error banner specifically.
    await expect(page.locator(".form-error")).toContainText(/identifiants invalides/i);
    await expect(page).toHaveURL(/\/login$/);
  });
});
