import { expect, test } from "@playwright/test";

/**
 * Minimal browser-journey example for `FND-04`. It intentionally avoids any
 * dependency on authentication or seeded data (neither exist yet) so it
 * keeps passing while `SEC-03` and later phases land; richer journeys are
 * added under `tests/e2e/` alongside the features they exercise.
 */
test("home route redirects into the app shell", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.ok()).toBeTruthy();
  await expect(page).toHaveURL(/\/caisse$/);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});

test("bottom/side navigation exposes the three main sections", async ({ page }) => {
  await page.goto("/caisse");
  const nav = page.getByRole("navigation");
  await expect(nav.getByRole("link", { name: /caisse/i })).toBeVisible();
  await expect(nav.getByRole("link", { name: /stock/i })).toBeVisible();
  await expect(nav.getByRole("link", { name: /bilan/i })).toBeVisible();
});
