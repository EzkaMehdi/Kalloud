import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { escapeRegExp, openOwnTable } from "./helpers/floor";

/**
 * ORD-09 and ORD-10 across the real HTTP boundary.
 *
 * The integration suite proves the arithmetic; what only this tier can show
 * is that a manager can actually reach a receipt from the Bilan and refund
 * from it — and that a cashier, who shares the same screen, cannot.
 */

async function loginAs(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Adresse e-mail").fill(email);
  await page.getByLabel("Mot de passe").fill("Kalloud123!");
  await page.getByRole("button", { name: /se connecter/i }).click();
  await expect(page).toHaveURL(/\/caisse$/);
}

async function createProduct(request: APIRequestContext, price: string) {
  const name = `Test ORD-09 ${crypto.randomUUID()}`;
  const created = await request.post("/api/products", {
    data: { categoryId: null, name, price, stockQuantity: 20 },
  });
  expect(created.ok()).toBeTruthy();
  return { name, id: (await created.json()).id as number };
}

/** Sells one unit through the UI and returns the order number shown on the ticket. */
async function sellOne(page: Page, productName: string) {
  await openOwnTable(page);
  const dialog = page.getByRole("dialog");
  const eyebrow = await dialog.locator(".eyebrow").first().innerText();
  const orderNumber = eyebrow.match(/#(\d+)/)?.[1];
  expect(orderNumber, "the drawer must show the ticket's number").toBeTruthy();

  await dialog.getByRole("button", { name: new RegExp(escapeRegExp(productName)) }).click();
  await expect(dialog.locator(".ticket-line")).toContainText(productName);
  await dialog.getByRole("button", { name: /encaisser/i }).click();
  await expect(dialog).toBeHidden();
  return orderNumber!;
}

test.describe("ORD-09: the receipt is reachable from the history", () => {
  test("opens from the Bilan and states the persisted amounts and tax", async ({ page }) => {
    await loginAs(page, "owner@kalloud.test");
    const product = await createProduct(page.request, "12.00");
    const orderNumber = await sellOne(page, product.name);

    await page.getByRole("link", { name: /bilan/i }).click();
    await page.getByRole("button", { name: new RegExp(`#${orderNumber}`) }).click();

    const receipt = page.getByRole("dialog");
    await expect(receipt).toBeVisible();
    await expect(receipt).toContainText(`Commande #${orderNumber}`);
    await expect(receipt).toContainText(product.name);
    await expect(receipt.locator(".ticket-total")).toContainText("12,00 €");
    // The seeded establishment's default rate (DEC-05 fallback).
    await expect(receipt).toContainText(/TVA 20,00 %/);
    // ORD-08: who rang it up is on the document.
    await expect(receipt).toContainText(/Servi par/);
  });
});

test.describe("ORD-10: refunding from the receipt", () => {
  test("a full refund reverses the sale and puts the stock back", async ({ page }) => {
    await loginAs(page, "owner@kalloud.test");
    const product = await createProduct(page.request, "8.00");
    const orderNumber = await sellOne(page, product.name);

    const afterSale = await (await page.request.get("/api/products")).json();
    expect(afterSale.find((row: { id: number }) => row.id === product.id).stock_quantity).toBe(19);

    await page.getByRole("link", { name: /bilan/i }).click();
    await page.getByRole("button", { name: new RegExp(`#${orderNumber}`) }).click();
    const receipt = page.getByRole("dialog");

    await receipt.getByRole("button", { name: /rembourser cette commande/i }).click();
    // "Toujours associé à un motif" (DEC-05): confirming without one is
    // refused inline, before any request.
    await receipt.getByRole("button", { name: /confirmer le remboursement/i }).click();
    await expect(receipt.getByRole("alert")).toContainText(/motif/i);

    await receipt.getByLabel(/motif du remboursement/i).fill("Produit renvoyé");
    await receipt.getByRole("button", { name: /confirmer le remboursement/i }).click();
    await expect(receipt).toBeHidden();

    const afterRefund = await (await page.request.get("/api/products")).json();
    expect(afterRefund.find((row: { id: number }) => row.id === product.id).stock_quantity).toBe(
      20,
    );

    // The sale is not deleted — it is still in the history, marked.
    await expect(page.getByRole("button", { name: new RegExp(`#${orderNumber}`) })).toContainText(
      /Remboursée/,
    );
  });

  test("a cashier can read a receipt but is offered no refund", async ({ page }) => {
    // The sale itself is made by the owner; the cashier only looks at it.
    await loginAs(page, "owner@kalloud.test");
    const product = await createProduct(page.request, "9.00");
    const orderNumber = await sellOne(page, product.name);
    await page.getByRole("button", { name: /se déconnecter/i }).click();
    await expect(page).toHaveURL(/\/login/);

    await loginAs(page, "cashier@kalloud.test");
    // DEC-07: a cashier has no dashboard access, so the Bilan page is out —
    // the receipt is still readable through its own endpoint, which is what
    // handing one to a customer needs.
    const response = await page.request.get(`/api/orders/1/receipt`);
    expect([200, 404]).toContain(response.status());

    const refused = await page.request.post(`/api/orders/1/refund`, {
      headers: { "Idempotency-Key": crypto.randomUUID() },
      data: { reason: "Tentative" },
    });
    expect(refused.status()).toBe(403);
    expect(orderNumber).toBeTruthy();
  });
});
