import { beforeEach, describe, expect, it } from "vitest";
import { pool } from "../../lib/db";
import { createProduct, getStockAlertCounts, updateProduct } from "../../lib/repositories/products";
import { getStockAtRisk } from "../../lib/services/stock-risk";
import { createTestTenant, createTestUser, type TestTenant } from "./helpers/fixtures";
import { resetDatabase } from "./helpers/reset-database";

/**
 * BI-10's livrable, verbatim: "ruptures, sous-seuils et actions de
 * réapprovisionnement." The service side of that — the two lists behind
 * BI-01's counts — proved here; the click-through to the movement form
 * ("alerte ouvre le produit et son formulaire de mouvement", the
 * acceptance) is an e2e concern (tests/e2e/stock-risk-block.spec.ts).
 */

let tenant: TestTenant;

beforeEach(async () => {
  await resetDatabase(pool);
  tenant = await createTestTenant(pool, "Stock Risk Tenant");
  await createTestUser(pool, tenant, "OWNER");
});

describe("BI-10: stock at risk", () => {
  it("splits products into rupture and sous-seuil, ignoring a deactivated product and a comfortable one", async () => {
    const outOfStock = await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "Rupture",
      price: "5.00",
      stockQuantity: 0,
      alertThreshold: 5,
    });
    const lowStock = await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "Sous seuil",
      price: "5.00",
      stockQuantity: 2,
      alertThreshold: 5,
    });
    await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "Stock confortable",
      price: "5.00",
      stockQuantity: 20,
      alertThreshold: 5,
    });
    const deactivatedOutOfStock = await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "Rupture désactivée",
      price: "5.00",
      stockQuantity: 0,
      alertThreshold: 5,
    });
    await updateProduct(pool, tenant.locationId, deactivatedOutOfStock.id, { isActive: false });

    const result = await getStockAtRisk(tenant.locationId);

    expect(result.outOfStock).toHaveLength(1);
    expect(result.outOfStock[0]).toMatchObject({ id: outOfStock.id, name: "Rupture" });
    expect(result.lowStock).toHaveLength(1);
    expect(result.lowStock[0]).toMatchObject({
      id: lowStock.id,
      name: "Sous seuil",
      stockQuantity: 2,
      alertThreshold: 5,
    });

    // The list lengths can never disagree with BI-01's own counted figure
    // — both are read from the same query.
    const counts = await getStockAlertCounts(pool, tenant.locationId);
    expect(result.outOfStock.length).toBe(counts.out_of_stock);
    expect(result.lowStock.length).toBe(counts.low_stock);
  });

  it("carries the product's category name, or null when it has none", async () => {
    const {
      rows: [category],
    } = await pool.query<{ id: number }>(
      "INSERT INTO categories (location_id, name) VALUES ($1, $2) RETURNING id",
      [tenant.locationId, "Boissons"],
    );
    await createProduct(pool, tenant.locationId, {
      categoryId: category.id,
      name: "Café",
      price: "5.00",
      stockQuantity: 0,
      alertThreshold: 5,
    });
    await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "Sans catégorie",
      price: "5.00",
      stockQuantity: 0,
      alertThreshold: 5,
    });

    const result = await getStockAtRisk(tenant.locationId);

    const withCategory = result.outOfStock.find((product) => product.name === "Café");
    const withoutCategory = result.outOfStock.find((product) => product.name === "Sans catégorie");
    expect(withCategory?.categoryName).toBe("Boissons");
    expect(withoutCategory?.categoryName).toBeNull();
  });

  it("never mixes another establishment's products into the lists", async () => {
    const otherTenant = await createTestTenant(pool, "Other Tenant");
    await createProduct(pool, otherTenant.locationId, {
      categoryId: null,
      name: "Produit d'un autre établissement",
      price: "5.00",
      stockQuantity: 0,
      alertThreshold: 5,
    });

    const result = await getStockAtRisk(tenant.locationId);

    expect(result.outOfStock).toHaveLength(0);
    expect(result.lowStock).toHaveLength(0);
  });
});
