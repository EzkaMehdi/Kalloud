import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { openOwnTable } from "./helpers/floor";

interface CheckoutResponse {
  order: { cash_amount: string; card_amount: string };
}

interface CreatedProduct {
  id: number;
  name: string;
}

/**
 * SALE-05's acceptance criterion, verbatim: "les trois moyens de paiement
 * produisent la ventilation attendue." Each test creates its own isolated
 * product (same reasoning as tests/e2e/sale-catalog.spec.ts: other e2e
 * specs sell from the shared seeded catalog concurrently, fullyParallel),
 * and asserts on the actual POST /api/checkout response the "Encaisser"
 * click triggers rather than inferring "the sale that just happened" from
 * a shared list — /api/orders' newest row is not reliably this test's own
 * under the same parallel-siblings race already found and fixed once
 * (tests/e2e/idempotency.spec.ts), so this sidesteps it entirely instead of
 * chasing another instance of it.
 */

async function login(request: APIRequestContext) {
  const response = await request.post("/api/auth/login", {
    data: { email: "owner@kalloud.test", password: "Kalloud123!" },
  });
  expect(response.ok()).toBeTruthy();
}

async function createProduct(request: APIRequestContext, price: string): Promise<CreatedProduct> {
  const response = await request.post("/api/products", {
    data: {
      categoryId: null,
      name: `Test SALE-05 ${crypto.randomUUID()}`,
      price,
      stockQuantity: 5,
    },
  });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function openTicketWithProduct(page: Page, product: CreatedProduct) {
  await page.goto("/caisse");
  await openOwnTable(page);
  const dialog = page.getByRole("dialog");
  const escaped = product.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  await dialog.getByRole("button", { name: new RegExp(escaped) }).click();
  return dialog;
}

test.describe("SALE-05: cash, card and mixed payments", () => {
  test("CB records card revenue only", async ({ page }) => {
    await login(page.request);
    const product = await createProduct(page.request, "10.00");
    const dialog = await openTicketWithProduct(page, product);

    await dialog.getByRole("radio", { name: "CB" }).click();
    const [response] = await Promise.all([
      page.waitForResponse(
        (res) => res.url().includes("/api/checkout") && res.request().method() === "POST",
      ),
      dialog.getByRole("button", { name: /encaisser/i }).click(),
    ]);
    const body: CheckoutResponse = await response.json();

    expect(body.order.card_amount).toBe("10.00");
    expect(body.order.cash_amount).toBe("0.00");
  });

  test("Espèces records cash revenue only", async ({ page }) => {
    await login(page.request);
    const product = await createProduct(page.request, "8.00");
    const dialog = await openTicketWithProduct(page, product);

    await dialog.getByRole("radio", { name: "Espèces" }).click();
    const [response] = await Promise.all([
      page.waitForResponse(
        (res) => res.url().includes("/api/checkout") && res.request().method() === "POST",
      ),
      dialog.getByRole("button", { name: /encaisser/i }).click(),
    ]);
    const body: CheckoutResponse = await response.json();

    expect(body.order.cash_amount).toBe("8.00");
    expect(body.order.card_amount).toBe("0.00");
  });

  test("Mixte splits the sale exactly as entered, when it sums to the total", async ({ page }) => {
    await login(page.request);
    const product = await createProduct(page.request, "20.00");
    const dialog = await openTicketWithProduct(page, product);

    await dialog.getByRole("radio", { name: "Mixte" }).click();
    await dialog.getByLabel("Espèces (€)").fill("12.00");
    await dialog.getByLabel("Carte (€)").fill("8.00");
    const [response] = await Promise.all([
      page.waitForResponse(
        (res) => res.url().includes("/api/checkout") && res.request().method() === "POST",
      ),
      dialog.getByRole("button", { name: /encaisser/i }).click(),
    ]);
    const body: CheckoutResponse = await response.json();

    expect(body.order.cash_amount).toBe("12.00");
    expect(body.order.card_amount).toBe("8.00");
  });

  test("Mixte refuses a split that does not sum to the total — inline, before any request is sent", async ({
    page,
  }) => {
    await login(page.request);
    const product = await createProduct(page.request, "20.00");
    const dialog = await openTicketWithProduct(page, product);

    await dialog.getByRole("radio", { name: "Mixte" }).click();
    await dialog.getByLabel("Espèces (€)").fill("12.00");
    await dialog.getByLabel("Carte (€)").fill("5.00"); // sums to 17.00, not 20.00

    let requestFired = false;
    page.on("request", (req) => {
      if (req.url().includes("/api/checkout") && req.method() === "POST") requestFired = true;
    });
    await dialog.getByRole("button", { name: /encaisser/i }).click();

    await expect(dialog.locator(".form-error")).toContainText(/somme des deux montants/i);
    expect(requestFired, "a mismatched split must be caught before any network request").toBe(
      false,
    );
  });
});
