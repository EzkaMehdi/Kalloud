import { beforeEach, describe, expect, it } from "vitest";
import { pool } from "../../lib/db";
import { createProduct, listProducts } from "../../lib/repositories/products";
import { createTestTenant, type TestTenant } from "./helpers/fixtures";
import { resetDatabase } from "./helpers/reset-database";

/**
 * SALE-01's acceptance criterion: "source unique pour caisse et stock."
 * These tests exercise listProducts directly — the function both
 * GET /api/products and (eventually) SALE-04's caisse catalog read from —
 * proving the fields the livrable asks for beyond what a plain product row
 * already carries: the resolved tax rule (DEC-05's product → category →
 * establishment fallback), and availability as a concept distinct from the
 * admin is_active flag (SALE-07 needs both, separately).
 */

let tenant: TestTenant;

async function createTaxClass(
  locationId: number,
  name: string,
  rate: string,
  isDefault = false,
): Promise<number> {
  const {
    rows: [row],
  } = await pool.query<{ id: number }>(
    "INSERT INTO tax_classes (location_id, name, rate, is_default) VALUES ($1, $2, $3, $4) RETURNING id",
    [locationId, name, rate, isDefault],
  );
  return row.id;
}

beforeEach(async () => {
  await resetDatabase(pool);
  tenant = await createTestTenant(pool, "Catalog Tenant");
});

describe("SALE-01: catalog tax rule resolution (DEC-05 fallback)", () => {
  it("uses the establishment's default_tax_rate when neither the product nor its category has a tax class", async () => {
    const product = await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "Sans classe fiscale",
      price: "10.00",
    });

    const [row] = await listProducts(pool, tenant.locationId);
    expect(row.id).toBe(product.id);
    // location_settings.default_tax_rate defaults to 20.00 (migrations/0002).
    expect(row.tax_rate_percent).toBe("20.00");
    expect(row.tax_class_name).toBeNull();
  });

  it("prefers the category's tax class over the establishment default", async () => {
    const {
      rows: [category],
    } = await pool.query<{ id: number }>(
      "INSERT INTO categories (location_id, name) VALUES ($1, $2) RETURNING id",
      [tenant.locationId, "Boissons"],
    );
    const taxClassId = await createTaxClass(tenant.locationId, "TVA réduite", "10.00");
    await pool.query("UPDATE categories SET tax_class_id = $1 WHERE id = $2", [
      taxClassId,
      category.id,
    ]);
    const product = await createProduct(pool, tenant.locationId, {
      categoryId: category.id,
      name: "Thé",
      price: "4.00",
    });

    const [row] = await listProducts(pool, tenant.locationId);
    expect(row.id).toBe(product.id);
    expect(row.tax_rate_percent).toBe("10.00");
    expect(row.tax_class_name).toBe("TVA réduite");
  });

  it("prefers the product's own tax class over its category's", async () => {
    const {
      rows: [category],
    } = await pool.query<{ id: number }>(
      "INSERT INTO categories (location_id, name) VALUES ($1, $2) RETURNING id",
      [tenant.locationId, "Restauration"],
    );
    const categoryTaxClassId = await createTaxClass(tenant.locationId, "TVA restauration", "10.00");
    await pool.query("UPDATE categories SET tax_class_id = $1 WHERE id = $2", [
      categoryTaxClassId,
      category.id,
    ]);
    const productTaxClassId = await createTaxClass(tenant.locationId, "TVA standard", "20.00");
    const product = await createProduct(pool, tenant.locationId, {
      categoryId: category.id,
      name: "Alcool fort",
      price: "12.00",
    });
    await pool.query("UPDATE products SET tax_class_id = $1 WHERE id = $2", [
      productTaxClassId,
      product.id,
    ]);

    const [row] = await listProducts(pool, tenant.locationId);
    expect(row.tax_rate_percent).toBe("20.00");
    expect(row.tax_class_name).toBe("TVA standard");
  });

  it("refuses at the database level to assign a product a tax class from another establishment", async () => {
    const otherTenant = await createTestTenant(pool, "Other Catalog Tenant");
    const otherTaxClassId = await createTaxClass(
      otherTenant.locationId,
      "Taux d'un autre tenant",
      "5.00",
    );
    const product = await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "Produit isolé",
      price: "6.00",
    });

    // products_tax_class_id_location_id_fkey (migrations/0003) is the
    // composite FK that makes this impossible — regression proof that it's
    // still there, not just documentation of an assumption. listProducts's
    // own location_id-scoped join (a second, redundant safeguard) is
    // covered separately by the fallback tests above: a product can never
    // actually reach this state to exercise it.
    await expect(
      pool.query("UPDATE products SET tax_class_id = $1 WHERE id = $2", [
        otherTaxClassId,
        product.id,
      ]),
    ).rejects.toThrow(/products_tax_class_id_location_id_fkey/);
  });
});

describe("SALE-01: availability distinct from active status (SALE-07's future need)", () => {
  it("is available when active with stock", async () => {
    const product = await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "En stock",
      price: "5.00",
      stockQuantity: 3,
    });
    const [row] = await listProducts(pool, tenant.locationId);
    expect(row.id).toBe(product.id);
    expect(row.is_active).toBe(true);
    expect(row.is_available).toBe(true);
  });

  it("is active but not available when stock is exhausted — and stays listed, not hidden", async () => {
    await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "Rupture",
      price: "5.00",
      stockQuantity: 0,
    });
    const [row] = await listProducts(pool, tenant.locationId);
    expect(row.is_active).toBe(true);
    expect(row.is_available).toBe(false);
  });

  it("is neither active nor available when deactivated, but is still returned (no is_active filter)", async () => {
    const product = await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "Discontinué",
      price: "5.00",
      stockQuantity: 10,
    });
    await pool.query("UPDATE products SET is_active = false WHERE id = $1", [product.id]);

    const rows = await listProducts(pool, tenant.locationId);
    const row = rows.find((r) => r.id === product.id);
    expect(row).toBeDefined();
    expect(row!.is_active).toBe(false);
    expect(row!.is_available).toBe(false);
  });

  it("reports the single MVP unit for every product (DEC-06)", async () => {
    await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "Produit",
      price: "1.00",
    });
    const [row] = await listProducts(pool, tenant.locationId);
    expect(row.unit).toBe("piece");
  });
});
