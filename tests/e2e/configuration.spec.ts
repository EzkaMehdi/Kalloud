import { expect, test, type Page } from "@playwright/test";

/**
 * CFG-04 and GATE-4B, through the browser.
 *
 * The integration suite proves the permission matrix and the persistence.
 * What only this tier shows is the half that matters to a user: that an
 * owner can reach the screen and change something, and that a manager is
 * told why part of it is inert instead of being handed a form that silently
 * fails on save.
 */

async function loginAs(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Adresse e-mail").fill(email);
  await page.getByLabel("Mot de passe").fill("Kalloud123!");
  await page.getByRole("button", { name: /se connecter/i }).click();
  await expect(page).toHaveURL(/\/caisse$/);
}

// Serial: both tests below write the establishment's single settings row.
// Run in parallel they overwrite each other's name — the same shared-mutable
// -state race the sale specs solved with a fixture of their own, except an
// establishment has exactly one settings row and cannot be duplicated.
test.describe.serial("CFG-01: an owner configures without SQL", () => {
  test("changes the establishment's name and sees it persisted after a reload", async ({
    page,
  }) => {
    await loginAs(page, "owner@kalloud.test");
    await page.getByRole("link", { name: /réglages/i }).click();
    await expect(page.getByRole("heading", { name: "Configuration" })).toBeVisible();

    const name = `Kalloud ${crypto.randomUUID().slice(0, 6)}`;
    await page.getByLabel(/nom de l’établissement/i).fill(name);
    await page.getByRole("button", { name: /enregistrer les réglages/i }).click();
    await expect(page.locator(".status")).toContainText(/enregistrés/i);

    // Reloaded from the server, not from what the form still holds.
    await page.reload();
    await expect(page.getByLabel(/nom de l’établissement/i)).toHaveValue(name);
  });

  test("refuses an unknown timezone with an explanation, not a silent no-op", async ({ page }) => {
    await loginAs(page, "owner@kalloud.test");
    await page.getByRole("link", { name: /réglages/i }).click();

    await page.getByLabel(/fuseau horaire/i).fill("Mars/Olympus_Mons");
    await page.getByRole("button", { name: /enregistrer les réglages/i }).click();
    await expect(page.locator(".form-error")).toContainText(/fuseau horaire inconnu/i);

    // Put it back, so the rest of the suite sees a sane establishment.
    await page.getByLabel(/fuseau horaire/i).fill("Europe/Paris");
    await page.getByRole("button", { name: /enregistrer les réglages/i }).click();
    await expect(page.locator(".status")).toContainText(/enregistrés/i);
  });
});

test.describe("CFG-04: a manager is not offered the owner's settings", () => {
  test("sees the screen, is told the settings are the owner's, and is refused by the server", async ({
    page,
  }) => {
    await loginAs(page, "manager@kalloud.test");
    await page.getByRole("link", { name: /réglages/i }).click();

    // The form is visible but inert, and says why (UX-01: never a control
    // that looks usable and silently fails).
    await expect(page.getByLabel(/nom de l’établissement/i)).toBeDisabled();
    await expect(page.getByText(/seul le propriétaire peut les modifier/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /enregistrer les réglages/i })).toHaveCount(0);

    // And the screen is not the guard: the server refuses it too.
    const refused = await page.request.put("/api/settings", {
      data: {
        name: "Tentative",
        timezone: "Europe/Paris",
        currency: "EUR",
        defaultTaxRate: "20.00",
        cashDiscrepancyThreshold: "5.00",
      },
    });
    expect(refused.status()).toBe(403);
  });

  test("can still administer the catalogue and the floor plan", async ({ page }) => {
    await loginAs(page, "manager@kalloud.test");
    await page.getByRole("link", { name: /réglages/i }).click();

    const tableName = `T-${crypto.randomUUID().slice(0, 6)}`;
    await page.getByLabel(/nouvelle table/i).fill(tableName);
    await page
      .locator(".history-card", { hasText: "Nouvelle table" })
      .getByRole("button", { name: /créer/i })
      .click();
    await expect(page.locator(".status")).toContainText(/table créée/i);
    await expect(page.getByText(tableName)).toBeVisible();
  });
});

test.describe("CFG-03: a table with an open ticket cannot be deactivated", () => {
  test("explains the refusal instead of hiding a table someone is serving", async ({ page }) => {
    await loginAs(page, "owner@kalloud.test");

    // Its own table, so no other spec's ticket can interfere.
    const tableName = `T-${crypto.randomUUID().slice(0, 6)}`;
    const created = await page.request.post("/api/tables", { data: { name: tableName } });
    expect(created.ok()).toBeTruthy();
    const tableId = (await created.json()).id as number;

    // Open a ticket on it.
    const opened = await page.request.post("/api/tickets", { data: { tableId } });
    expect(opened.ok()).toBeTruthy();

    const refused = await page.request.patch(`/api/tables/${tableId}`, {
      data: { isActive: false },
    });
    expect(refused.status()).toBe(409);
    expect((await refused.json()).error.message).toMatch(/ticket ouvert/i);

    // Still on the floor plan, because it is still being served.
    await page.goto("/caisse");
    await expect(page.getByRole("button", { name: new RegExp(tableName) })).toBeVisible();
  });
});
