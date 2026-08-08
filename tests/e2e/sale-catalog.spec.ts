import { expect, test } from "@playwright/test";
import { openOwnTable } from "./helpers/floor";

interface CatalogProduct {
  id: number;
  name: string;
  price: string;
  stock_quantity: number;
  is_active: boolean;
}

/**
 * SALE-04's acceptance criterion, verbatim: "produit affiché, prix utilisé
 * et produit déstocké sont identiques." Not provable at the integration
 * tier (that only reaches performCheckout directly, never the drawer's own
 * fetch/click/render wiring) — this drives the real browser through
 * "open a table, click a real catalog product, pay" and checks the same
 * row's stock actually moved, closing the loop the old hardcoded catalog
 * (P0-03) could never guarantee.
 *
 * Creates its own product rather than picking one from the seeded catalog:
 * other e2e specs (tests/e2e/idempotency.spec.ts) sell from that same
 * seeded catalog concurrently (fullyParallel), so reading a seeded
 * product's stock "before", letting something else decrement it in
 * between, then asserting "after" would be racy — the exact shared-mutable-
 * state problem tests/e2e/idempotency.spec.ts's own tests had with each
 * other, here across files instead of within one. A dedicated product no
 * other spec knows about removes the race instead of chasing it.
 */
test.describe("SALE-04: the order drawer loads the real, scoped catalog", () => {
  test("adding a real catalog product decrements exactly that product's stock", async ({
    page,
  }) => {
    await page.goto("/login");
    await page.getByLabel("Adresse e-mail").fill("owner@kalloud.test");
    await page.getByLabel("Mot de passe").fill("Kalloud123!");
    await page.getByRole("button", { name: /se connecter/i }).click();
    await expect(page).toHaveURL(/\/caisse$/);

    const productName = `Test SALE-04 ${crypto.randomUUID()}`;
    const created = await page.request.post("/api/products", {
      data: { categoryId: null, name: productName, price: "9.50", stockQuantity: 5 },
    });
    expect(created.ok(), "creating the test's own isolated product must succeed").toBeTruthy();
    const product: CatalogProduct = await created.json();

    await openOwnTable(page);
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // The button's accessible name is "<name><price> €" (name and price
    // share one <button>), so this matches on the name as a substring
    // rather than exactly — still proves the drawer rendered the real
    // catalog entry just created via the API, not a hardcoded local one
    // (P0-03: the old constant's names/ids never matched real data at all).
    const escapedName = productName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    await dialog.getByRole("button", { name: new RegExp(escapedName) }).click();

    // The ticket line's price is the same row's price, not a hardcoded one.
    await expect(dialog.locator(".ticket-line")).toContainText(productName);
    await expect(dialog.locator(".ticket-line")).toContainText("9.50 €");

    await dialog.getByRole("button", { name: /encaisser/i }).click();
    await expect(dialog).toBeHidden();

    const productsAfter: CatalogProduct[] = await (await page.request.get("/api/products")).json();
    const sold = productsAfter.find((row) => row.id === product.id);
    // The exact same id the drawer displayed and priced is the one whose
    // stock moved — and by exactly one unit, not some other row's.
    expect(sold?.stock_quantity).toBe(4);
  });
});
