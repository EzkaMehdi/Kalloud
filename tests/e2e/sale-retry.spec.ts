import { expect, test, type APIRequestContext } from "@playwright/test";
import { openOwnTable } from "./helpers/floor";

interface CreatedProduct {
  id: number;
  name: string;
  stock_quantity: number;
}

/**
 * SALE-08's acceptance criterion, verbatim: "retry après timeout sans
 * doublon ; résultat existant récupéré." The server side of that guarantee
 * (lib/idempotency.ts, DEC-08's "un retry avec la même clé renvoie le
 * résultat déjà enregistré") already has direct coverage in
 * tests/e2e/idempotency.spec.ts — this file proves the layer SALE-08 adds on
 * top of it: components/order-drawer.tsx must recognise a network-layer
 * failure as *uncertain* (DEC-08's "le client ne sait pas si le serveur a
 * traité la demande"), say so distinctly, and retry with the exact same key
 * rather than starting a fresh attempt.
 *
 * Creates its own isolated product for the same reason as every other e2e
 * spec here (tests/e2e/sale-catalog.spec.ts): fullyParallel specs sell
 * against the same seeded tenant, so a shared product's stock would be a
 * race, not a proof.
 */

async function login(request: APIRequestContext) {
  const response = await request.post("/api/auth/login", {
    data: { email: "owner@kalloud.test", password: "Kalloud123!" },
  });
  expect(response.ok()).toBeTruthy();
}

async function createProduct(request: APIRequestContext): Promise<CreatedProduct> {
  const response = await request.post("/api/products", {
    data: {
      categoryId: null,
      name: `Test SALE-08 ${crypto.randomUUID()}`,
      price: "8.00",
      stockQuantity: 5,
    },
  });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

test.describe("SALE-08: a lost response is uncertain, not a failure to fix", () => {
  test("a network failure shows an uncertain state, and the retry reuses the same idempotency key without creating a duplicate sale", async ({
    page,
  }) => {
    await login(page.request);
    const product = await createProduct(page.request);

    // The first POST /api/checkout is aborted before it ever leaves the
    // browser — simulating DEC-08's "réponse non reçue" without needing a
    // real dropped connection. Every subsequent one (the retry) goes
    // through untouched. Both attempts' Idempotency-Key headers are
    // captured to prove the retry did not mint a new one.
    const idempotencyKeysSent: string[] = [];
    let checkoutAttempts = 0;
    await page.route("**/api/checkout", async (route) => {
      const request = route.request();
      idempotencyKeysSent.push(request.headers()["idempotency-key"] ?? "");
      checkoutAttempts += 1;
      if (checkoutAttempts === 1) {
        await route.abort("connectionfailed");
        return;
      }
      await route.continue();
    });

    await page.goto("/caisse");
    await openOwnTable(page);
    const dialog = page.getByRole("dialog");
    const escaped = product.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    await dialog
      .locator(".products")
      .getByRole("button", { name: new RegExp(escaped) })
      .click();
    await dialog.getByRole("radio", { name: "Espèces" }).click();

    const checkoutButton = dialog.getByRole("button", { name: /encaisser/i });
    await checkoutButton.click();

    // Distinct from a definitive rejection (SALE-07's ".form-error"): this
    // is ".form-warning", and names the actual situation and the way out.
    const notice = dialog.locator(".form-warning");
    await expect(notice).toContainText(/connexion perdue/i);
    await expect(notice).toContainText(/vérifier le paiement/i);
    const retryButton = dialog.getByRole("button", { name: /vérifier le paiement/i });
    await expect(retryButton).toBeVisible();

    // Nothing about the ticket was cleared while the outcome was unknown —
    // there is still something to retry, not a blank drawer.
    await expect(dialog.locator(".ticket-line")).toHaveCount(1);

    await retryButton.click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(/vente encaissée/i)).toBeVisible();

    expect(checkoutAttempts).toBe(2);
    expect(idempotencyKeysSent).toHaveLength(2);
    expect(idempotencyKeysSent[0]).toBeTruthy();
    // The retry is the *same* attempt as far as the server is concerned —
    // a fresh key here would defeat DEC-08's whole guarantee.
    expect(idempotencyKeysSent[1]).toBe(idempotencyKeysSent[0]);

    // The aborted first attempt never reached the server (nothing to
    // duplicate), and the retry is the only checkout that ever ran: stock
    // moved by exactly one unit, not two.
    const productsAfter: CreatedProduct[] = await (await page.request.get("/api/products")).json();
    const sold = productsAfter.find((row) => row.id === product.id);
    expect(sold?.stock_quantity).toBe(4);
  });
});
