import { expect, test, type APIRequestContext } from "@playwright/test";

interface CreatedProduct {
  id: number;
  name: string;
}

/**
 * SALE-06's acceptance criterion, verbatim: "aucune incrémentation
 * financière calculée uniquement côté client ; une vente espèces
 * rafraîchit le solde espèces." Two separate claims, two separate proofs
 * below — neither provable at the integration tier, which never reaches
 * the drawer's own display/refetch wiring.
 *
 * Balance assertions compare "changed and increased by at least this sale's
 * amount" rather than an exact before+price total: other e2e specs sell
 * concurrently against the same seeded tenant's cash balance
 * (fullyParallel), so an exact-equality assertion would be the same
 * shared-mutable-state race already found and fixed once
 * (tests/e2e/idempotency.spec.ts). ">= before + price, and different from
 * before" is what a concurrency-safe assertion of "it refreshed" looks
 * like; the exact arithmetic is already proven at the integration tier
 * (tests/integration/checkout-tax.test.ts, tests/integration/business-day.test.ts).
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
      name: `Test SALE-06 ${crypto.randomUUID()}`,
      price,
      stockQuantity: 5,
    },
  });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

test.describe("SALE-06: the server's response is the truth", () => {
  test("the confirmation message reports the server's own total, not a client recomputation", async ({
    page,
  }) => {
    await login(page.request);
    const product = await createProduct(page.request, "15.00");

    await page.goto("/caisse");
    await page.getByRole("button", { name: /table 1/i }).click();
    const dialog = page.getByRole("dialog");
    const escaped = product.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    await dialog.getByRole("button", { name: new RegExp(escaped) }).click();
    await dialog.getByRole("radio", { name: "Espèces" }).click();

    const [response] = await Promise.all([
      page.waitForResponse(
        (res) => res.url().includes("/api/checkout") && res.request().method() === "POST",
      ),
      dialog.getByRole("button", { name: /encaisser/i }).click(),
    ]);
    const body: { order: { total_amount: string } } = await response.json();
    expect(body.order.total_amount).toBe("15.00");

    // The drawer closes and app/caisse/page.tsx's done() shows this notice
    // built from exactly the number onComplete was called with — proving
    // the display path carries the server's figure through, not a
    // recomputed one, end to end. Matched by text, not role("status"): the
    // refetches this triggers briefly put AsyncSection's own "Chargement…"
    // (also role="status") on the page at the same time.
    await expect(page.getByText(/vente encaissée/i)).toContainText("15.00");
  });

  test("a cash sale refreshes the displayed cash balance without a page reload", async ({
    page,
  }) => {
    await login(page.request);
    const product = await createProduct(page.request, "6.00");

    await page.goto("/caisse");
    const balanceLocator = page.locator(".cash-card strong");
    await expect(balanceLocator).not.toHaveText("…");
    const beforeText = await balanceLocator.innerText();
    const before = Number(beforeText.replace(/[^\d,.-]/g, "").replace(",", "."));

    await page.getByRole("button", { name: /table 1/i }).click();
    const dialog = page.getByRole("dialog");
    const escaped = product.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    await dialog.getByRole("button", { name: new RegExp(escaped) }).click();
    await dialog.getByRole("radio", { name: "Espèces" }).click();
    await dialog.getByRole("button", { name: /encaisser/i }).click();
    await expect(dialog).toBeHidden();

    // No page.reload() anywhere above: if this changed at all, it is
    // because done() actually called cashQuery.refetch(), not because the
    // page was reloaded and re-fetched everything from scratch. Two waits,
    // in this order: first past the stale value (which the refetch's own
    // "…" loading placeholder already satisfies), then specifically for a
    // real "N,NN €" shape — otherwise reading .innerText() right after
    // could still land mid-refetch, on "…" rather than the settled figure.
    await expect(balanceLocator).not.toHaveText(beforeText);
    await expect(balanceLocator).toHaveText(/^\d[\d\s]*,\d{2}\s?€$/);
    const after = Number(
      (await balanceLocator.innerText()).replace(/[^\d,.-]/g, "").replace(",", "."),
    );
    expect(after).toBeGreaterThanOrEqual(before + 6);
  });
});
