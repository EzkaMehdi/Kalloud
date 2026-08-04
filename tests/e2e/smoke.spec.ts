import { expect, test } from "@playwright/test";

/**
 * Minimal browser-journey examples for `FND-04`/`SEC-03`. Anonymous access
 * to any business page must land on /login (proxy.ts), never on the page
 * itself with empty/fake data.
 */
test("home route redirects an anonymous visitor to login", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.ok()).toBeTruthy();
  await expect(page).toHaveURL(/\/login\?next=%2Fcaisse$/);
  await expect(page.getByRole("heading", { name: "Connexion" })).toBeVisible();
});

test("visiting a protected page directly also redirects to login", async ({ page }) => {
  await page.goto("/bilan");
  await expect(page).toHaveURL(/\/login\?next=%2Fbilan$/);
});

test("health endpoints respond without authentication", async ({ request }) => {
  const live = await request.get("/api/health/live");
  expect(live.ok()).toBeTruthy();
  const ready = await request.get("/api/health/ready");
  expect(ready.ok()).toBeTruthy();
});
