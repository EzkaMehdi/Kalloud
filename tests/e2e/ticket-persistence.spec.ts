import { expect, test } from "@playwright/test";
import { escapeRegExp, openOwnTable } from "./helpers/floor";

/**
 * ORD-04's acceptance criterion, verbatim: "fermer, changer de route ou
 * rafraîchir ne perd aucun article."
 *
 * This is the one claim no integration test can make. The service tier can
 * prove the rows are there (tests/integration/tickets.test.ts does); only a
 * real browser can prove the drawer has no client-only state that a reload
 * would take with it — which is exactly what it had before ORD-02, when the
 * ticket lived in a `useState` array and closing the drawer threw it away.
 */

async function loginAsOwner(page: import("@playwright/test").Page) {
  await page.goto("/login");
  await page.getByLabel("Adresse e-mail").fill("owner@kalloud.test");
  await page.getByLabel("Mot de passe").fill("Kalloud123!");
  await page.getByRole("button", { name: /se connecter/i }).click();
  await expect(page).toHaveURL(/\/caisse$/);
}

async function createProduct(page: import("@playwright/test").Page, price: string) {
  const name = `Test ORD-04 ${crypto.randomUUID()}`;
  const created = await page.request.post("/api/products", {
    data: { categoryId: null, name, price, stockQuantity: 20 },
  });
  expect(created.ok()).toBeTruthy();
  return name;
}

test.describe("ORD-04: a ticket outlives the browser", () => {
  test("a full page reload finds the same lines still on the table", async ({ page }) => {
    await loginAsOwner(page);
    const productName = await createProduct(page, "4.00");
    const tableName = await openOwnTable(page);

    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: new RegExp(escapeRegExp(productName)) }).click();
    await expect(dialog.locator(".ticket-line")).toContainText(productName);
    await expect(dialog.locator(".ticket-total")).toContainText("4.00 €");

    // Not a client-side navigation: a genuine reload, which discards every
    // bit of React state the drawer was holding.
    await page.reload();

    // The floor plan itself remembers, before anything is reopened.
    const tableCard = page.getByRole("button", { name: new RegExp(escapeRegExp(tableName)) });
    await expect(tableCard).toContainText("EN COURS");
    await expect(tableCard).toContainText("4,00 €");

    await tableCard.click();
    const resumed = page.getByRole("dialog");
    await expect(resumed).toBeVisible();
    await expect(resumed.locator(".ticket-line")).toContainText(productName);
    await expect(resumed.locator(".ticket-total")).toContainText("4.00 €");
  });

  test("closing the drawer leaves the table occupied, and reopening resumes the ticket", async ({
    page,
  }) => {
    await loginAsOwner(page);
    const productName = await createProduct(page, "3.00");
    const tableName = await openOwnTable(page);

    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: new RegExp(escapeRegExp(productName)) }).click();
    await expect(dialog.locator(".ticket-line")).toContainText(productName);

    // ORD-03: closing the drawer is not abandoning the order. The table
    // stays busy because the ticket is still open — the two cannot disagree,
    // since one is derived from the other.
    await dialog.getByRole("button", { name: /fermer/i }).click();
    await expect(dialog).toBeHidden();

    const tableCard = page.getByRole("button", { name: new RegExp(escapeRegExp(tableName)) });
    await expect(tableCard).toContainText("EN COURS");

    await tableCard.click();
    await expect(page.getByRole("dialog").locator(".ticket-line")).toContainText(productName);
  });

  test("paying the ticket frees the table without any separate status write", async ({ page }) => {
    await loginAsOwner(page);
    const productName = await createProduct(page, "5.00");
    const tableName = await openOwnTable(page);

    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: new RegExp(escapeRegExp(productName)) }).click();
    await expect(dialog.locator(".ticket-total")).toContainText("5.00 €");
    await dialog.getByRole("button", { name: /encaisser/i }).click();
    await expect(dialog).toBeHidden();

    const tableCard = page.getByRole("button", { name: new RegExp(escapeRegExp(tableName)) });
    await expect(tableCard).toContainText("LIBRE");
    await expect(tableCard).toContainText("Disponible");
  });

  test("a second device editing the same ticket is refused, not silently overwritten", async ({
    browser,
  }) => {
    // Two independent browser contexts: two real devices on the same
    // establishment, which DEC-08 explicitly allows ("pas une session unique
    // verrouillée") and which ORD-05 has to resolve without either one
    // losing work unknowingly.
    const first = await browser.newContext();
    const second = await browser.newContext();
    try {
      const pageA = await first.newPage();
      const pageB = await second.newPage();
      await loginAsOwner(pageA);
      await loginAsOwner(pageB);

      const productName = await createProduct(pageA, "2.00");
      const tableName = await openOwnTable(pageA);

      // Device B opens the same table's ticket and holds that version.
      await pageB.reload();
      await pageB.getByRole("button", { name: new RegExp(escapeRegExp(tableName)) }).click();
      const dialogB = pageB.getByRole("dialog");
      await expect(dialogB).toBeVisible();

      // Device A saves first, moving the ticket past B's version.
      const dialogA = pageA.getByRole("dialog");
      await dialogA.getByRole("button", { name: new RegExp(escapeRegExp(productName)) }).click();
      await expect(dialogA.locator(".ticket-line")).toContainText(productName);

      // B now writes against a version that no longer exists.
      await dialogB.getByRole("button", { name: new RegExp(escapeRegExp(productName)) }).click();
      await expect(dialogB.getByRole("alert")).toContainText(/modifié depuis un autre appareil/i);
      // Told to reload rather than offered a "pay" button over a stale list.
      await expect(dialogB.getByRole("button", { name: /recharger le ticket/i })).toBeVisible();

      // Reloading resolves it: B sees A's line and can carry on.
      await dialogB.getByRole("button", { name: /recharger le ticket/i }).click();
      await expect(dialogB.locator(".ticket-line")).toContainText(productName);
      await expect(dialogB.getByRole("button", { name: /encaisser/i })).toBeVisible();
    } finally {
      await first.close();
      await second.close();
    }
  });
});
