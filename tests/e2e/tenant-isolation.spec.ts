import { Pool } from "pg";
import { expect, test } from "@playwright/test";

/**
 * SEC-08, exercised through the real HTTP + cookie + Next.js request
 * pipeline (the repository-level guarantees are covered exhaustively by
 * tests/integration/tenant-isolation.test.ts, which cannot go through
 * app/api/**\/route.ts directly — see that file's header comment). Creates
 * a second, throwaway tenant/product directly in the dev database the
 * Playwright web server is already using, then proves the seeded tenant's
 * owner cannot read or modify it through the API.
 */
test.describe("tenant isolation over HTTP (SEC-08)", () => {
  let pool: Pool;
  let otherOrganizationId: number;
  let otherProductId: number;

  test.beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const {
      rows: [org],
    } = await pool.query<{ id: number }>(
      "INSERT INTO organizations (name) VALUES ($1) RETURNING id",
      ["E2E Isolation Org"],
    );
    otherOrganizationId = org.id;
    const {
      rows: [location],
    } = await pool.query<{ id: number }>(
      "INSERT INTO locations (organization_id, name) VALUES ($1, $2) RETURNING id",
      [org.id, "E2E Isolation Location"],
    );
    const {
      rows: [product],
    } = await pool.query<{ id: number }>(
      "INSERT INTO products (location_id, name, price, stock_quantity) VALUES ($1, 'Other Tenant Product', 10.00, 5) RETURNING id",
      [location.id],
    );
    otherProductId = product.id;
  });

  test.afterAll(async () => {
    // Deletes the organization, which cascades to its location and product.
    await pool.query("DELETE FROM organizations WHERE id = $1", [otherOrganizationId]);
    await pool.end();
  });

  test("the seeded owner cannot read or modify another tenant's product by id", async ({
    page,
  }) => {
    await page.goto("/login");
    await page.getByLabel("Adresse e-mail").fill("owner@kalloud.test");
    await page.getByLabel("Mot de passe").fill("Kalloud123!");
    await page.getByRole("button", { name: /se connecter/i }).click();
    await expect(page).toHaveURL(/\/caisse$/);

    const productList = await page.request.get("/api/products");
    const products = (await productList.json()) as Array<{ id: number }>;
    expect(products.some((product) => product.id === otherProductId)).toBe(false);

    const patchResponse = await page.request.patch(`/api/products/${otherProductId}`, {
      data: { name: "Renamed by another tenant" },
    });
    expect(patchResponse.status()).toBe(404);

    // STK-04 replaced the absolute `PATCH { quantity }` by a delta
    // adjustment; the isolation guarantee is what this asserts, and it holds
    // whichever shape the write takes.
    const stockResponse = await page.request.post(`/api/products/${otherProductId}/stock`, {
      data: { delta: 9999, type: "RECEIPT", reason: "Tentative inter-établissement" },
    });
    expect(stockResponse.status()).toBe(404);
  });
});
