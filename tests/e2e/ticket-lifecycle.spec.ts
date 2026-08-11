import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { escapeRegExp, openOwnTable } from "./helpers/floor";

/**
 * ORD-13 and GATE-4A, through the browser.
 *
 * The integration suite walks the same journey at the service tier
 * (tests/integration/discounts-history.test.ts). What this adds is the part
 * a service call cannot make a claim about: that a real user can get from
 * one end to the other without the screen losing the ticket, and that the
 * floor plan agrees with the database at every step.
 */

async function loginAsOwner(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Adresse e-mail").fill("owner@kalloud.test");
  await page.getByLabel("Mot de passe").fill("Kalloud123!");
  await page.getByRole("button", { name: /se connecter/i }).click();
  await expect(page).toHaveURL(/\/caisse$/);
}

async function createProduct(request: APIRequestContext, price: string) {
  const name = `Test ORD-13 ${crypto.randomUUID()}`;
  const created = await request.post("/api/products", {
    data: { categoryId: null, name, price, stockQuantity: 20 },
  });
  expect(created.ok()).toBeTruthy();
  return { name, id: (await created.json()).id as number };
}

test.describe("ORD-13: a ticket's whole life, in the browser", () => {
  test("open, fill, discount, reload, pay, then refund — losing nothing", async ({ page }) => {
    await loginAsOwner(page);
    const product = await createProduct(page.request, "10.00");
    const tableName = await openOwnTable(page);

    const dialog = page.getByRole("dialog");
    const orderNumber = (await dialog.locator(".eyebrow").first().innerText()).match(/#(\d+)/)?.[1];
    expect(orderNumber).toBeTruthy();

    // Fill.
    await dialog.getByRole("button", { name: new RegExp(escapeRegExp(product.name)) }).click();
    await dialog.getByRole("button", { name: new RegExp(escapeRegExp(product.name)) }).click();
    await expect(dialog.locator(".ticket-total")).toContainText("20.00 €");

    // Discount — ORD-11, owner has `orders:discount`.
    await dialog.getByRole("button", { name: /appliquer une remise/i }).click();
    await dialog.getByLabel(/remise \(€\)/i).fill("5");
    await dialog.getByLabel(/motif de la remise/i).fill("Client fidèle");
    await dialog.getByRole("button", { name: /appliquer la remise/i }).click();
    await expect(dialog.getByText(/Remise appliquée/)).toBeVisible();

    // Reload: nothing about the ticket lived only in the browser.
    await page.reload();
    const tableCard = page.getByRole("button", { name: new RegExp(escapeRegExp(tableName)) });
    await expect(tableCard).toContainText("EN COURS");
    await tableCard.click();
    const resumed = page.getByRole("dialog");
    // 20 € of lines less the 5 € discount. This assertion used to expect
    // 20 € — it encoded the defect it was meant to guard: the ticket showed
    // the list price while the server was about to charge 15 €.
    await expect(resumed.locator(".ticket-total")).toContainText("15.00 €");
    await expect(resumed.getByText(/Remise appliquée/)).toBeVisible();
    await expect(resumed.getByRole("button", { name: /encaisser/i })).toContainText("15.00 €");

    // Pay — the amount the button states.
    await resumed.getByRole("button", { name: /encaisser/i }).click();
    await expect(resumed).toBeHidden();
    // The confirmation reports the server's own total (SALE-06), formatted
    // by the caisse with a dot. Matched by text rather than by role: the
    // page carries more than one live region.
    await expect(page.getByText(/Vente encaissée \(15\.00 €\)/)).toBeVisible();

    // GATE-4A: the table is free again, derived from the ticket's state.
    await expect(
      page.getByRole("button", { name: new RegExp(escapeRegExp(tableName)) }),
    ).toContainText("LIBRE");

    // The stock moved by exactly what was sold.
    const afterSale = await (await page.request.get("/api/products")).json();
    expect(afterSale.find((row: { id: number }) => row.id === product.id).stock_quantity).toBe(18);

    // Refund from the receipt — ORD-09 into ORD-10.
    await page.getByRole("link", { name: /bilan/i }).click();
    await page.getByRole("button", { name: new RegExp(`#${orderNumber}`) }).click();
    const receipt = page.getByRole("dialog");
    await expect(receipt).toContainText("Remise");
    await expect(receipt.locator(".ticket-total")).toContainText("15,00 €");

    await receipt.getByRole("button", { name: /rembourser cette commande/i }).click();
    await receipt.getByLabel(/motif du remboursement/i).fill("Client mécontent");
    await receipt.getByRole("button", { name: /confirmer le remboursement/i }).click();
    await expect(receipt).toBeHidden();

    // Nothing was deleted: the sale is still there, marked, and the stock
    // came back.
    await expect(page.getByRole("button", { name: new RegExp(`#${orderNumber}`) })).toContainText(
      /Remboursée/,
    );
    const afterRefund = await (await page.request.get("/api/products")).json();
    expect(afterRefund.find((row: { id: number }) => row.id === product.id).stock_quantity).toBe(
      20,
    );
  });

  test("a cancelled ticket frees its table and stays in the history", async ({ page }) => {
    await loginAsOwner(page);
    const product = await createProduct(page.request, "6.00");
    const tableName = await openOwnTable(page);

    const dialog = page.getByRole("dialog");
    const orderNumber = (await dialog.locator(".eyebrow").first().innerText()).match(/#(\d+)/)?.[1];
    await dialog.getByRole("button", { name: new RegExp(escapeRegExp(product.name)) }).click();
    await dialog.getByRole("button", { name: /annuler le ticket/i }).click();
    await dialog.getByLabel(/motif de l'annulation/i).fill("Client parti");
    await dialog.getByRole("button", { name: /confirmer l'annulation/i }).click();
    await expect(dialog).toBeHidden();

    await expect(
      page.getByRole("button", { name: new RegExp(escapeRegExp(tableName)) }),
    ).toContainText("LIBRE");

    // GATE-4A: "annulation, paiement et remboursement laissent une trace".
    await page.getByRole("link", { name: /bilan/i }).click();
    await page.getByRole("tab", { name: /annulées/i }).click();
    await expect(page.getByRole("button", { name: new RegExp(`#${orderNumber}`) })).toContainText(
      /Annulée/,
    );
  });
});

test.describe("ORD-12: the history filters and paginates", () => {
  test("narrows to one status and reports how many rows there are", async ({ page }) => {
    await loginAsOwner(page);
    const product = await createProduct(page.request, "4.00");

    // Make sure there is at least one paid order to page over — other specs
    // sell concurrently, so this test provides its own rather than assuming.
    await openOwnTable(page);
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: new RegExp(escapeRegExp(product.name)) }).click();
    await dialog.getByRole("button", { name: /encaisser/i }).click();
    await expect(dialog).toBeHidden();

    await page.getByRole("link", { name: /bilan/i }).click();
    // The filter is the same list, narrowed — not a second screen.
    await page.getByRole("tab", { name: /encaissées/i }).click();

    // A paginator that cannot say how many rows exist can only offer
    // "next"; this one states the range and the total.
    await expect(page.locator(".history-pager small")).toContainText(/sur \d+/);
    // On the first page there is nothing before.
    await expect(page.getByRole("button", { name: /précédentes/i })).toBeDisabled();
  });

  test("filtering to a status with no rows says so instead of showing a blank list", async ({
    page,
  }) => {
    await loginAsOwner(page);
    await page.getByRole("link", { name: /bilan/i }).click();
    await page.getByRole("tab", { name: /annulées/i }).click();

    // Either there are cancelled orders (another spec cancels one) or the
    // screen says there are none — never an unexplained empty area.
    const pager = page.locator(".history-pager small");
    const empty = page.getByText(/Aucune commande encaissée pour le moment/);
    await expect(pager.or(empty).first()).toBeVisible();
  });
});

test.describe("ORD-11: the discount is visible in what will be charged", () => {
  test("the Encaisser button states the discounted amount, not the list price", async ({
    page,
  }) => {
    await loginAsOwner(page);
    const product = await createProduct(page.request, "20.00");
    await openOwnTable(page);

    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: new RegExp(escapeRegExp(product.name)) }).click();
    await expect(dialog.locator(".ticket-total")).toContainText("20.00 €");

    await dialog.getByRole("button", { name: /appliquer une remise/i }).click();
    await dialog.getByRole("radio", { name: /pourcentage/i }).click();
    await dialog.getByLabel(/remise \(%\)/i).fill("10");
    await dialog.getByLabel(/motif de la remise/i).fill("Client fidèle");
    await dialog.getByRole("button", { name: /appliquer la remise/i }).click();

    // The defect this covers: the discount was recorded but the total and
    // the button still showed 20 €, so the cashier read it as "it did not
    // work" — while the server was about to charge 18 €. A checkout button
    // must state what will actually be taken.
    await expect(dialog.locator(".ticket-total")).toContainText("18.00 €");
    await expect(dialog.getByRole("button", { name: /encaisser/i })).toContainText("18.00 €");
    // And the lines still reconcile with it on screen.
    await expect(dialog).toContainText("Sous-total");
    await expect(dialog).toContainText("− 2.00 €");

    // A mixed split that adds up to the *discounted* total is accepted —
    // it was refused inline while the client compared against the gross.
    await dialog.getByRole("radio", { name: "Mixte" }).click();
    await dialog.getByLabel(/espèces/i).fill("8");
    await dialog.getByLabel(/carte/i).fill("10");
    await dialog.getByRole("button", { name: /encaisser/i }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(/Vente encaissée \(18\.00 €\)/)).toBeVisible();
  });
});
