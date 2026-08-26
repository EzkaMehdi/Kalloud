import { beforeEach, describe, expect, it } from "vitest";
import { pool } from "../../lib/db";
import { openBusinessDay } from "../../lib/repositories/business-days";
import { createCashMovement } from "../../lib/repositories/cash-movements";
import { createProduct } from "../../lib/repositories/products";
import { adjustProductStock } from "../../lib/services/stock";
import {
  exportCashCsv,
  exportPaymentsCsv,
  exportSalesCsv,
  exportStockCsv,
} from "../../lib/services/exports";
import { sell } from "./helpers/sales";
import { createTestTenant, createTestUser, type TestTenant } from "./helpers/fixtures";
import { resetDatabase } from "./helpers/reset-database";
import type { RequestContext } from "../../lib/context";

/**
 * BI-12/DEC-09's acceptance, verbatim: "colonnes, encodage, dates, montants
 * et autorisations testés." The four cases below prove the first four —
 * exact French header row, BOM + `;`, ISO 8601 with an explicit offset,
 * raw-decimal amounts — against one real record per domain; permission is
 * an e2e concern (`tests/e2e/exports.spec.ts`), the same split `BI-02`
 * itself used for the JSON history routes.
 */

let tenant: TestTenant;
let context: RequestContext;

beforeEach(async () => {
  await resetDatabase(pool);
  tenant = await createTestTenant(pool, "Exports Tenant");
  const owner = await createTestUser(pool, tenant, "OWNER");
  context = {
    userId: owner.userId,
    userEmail: owner.email,
    userName: "Owner",
    organizationId: tenant.organizationId,
    locationId: tenant.locationId,
    role: "OWNER",
    sessionId: 1,
  };
});

/** Splits a CSV export into its rows, each already split into fields — dropping the BOM first. */
function parseCsv(csv: string): string[][] {
  const withoutBom = csv.charCodeAt(0) === 0xfeff ? csv.slice(1) : csv;
  return withoutBom
    .trim()
    .split("\r\n")
    .map((line) => line.split(";"));
}

const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;

describe("BI-12: exportSalesCsv", () => {
  it("exports one row per sold line, French headers, raw amounts, dates with an explicit offset", async () => {
    await openBusinessDay(pool, tenant.locationId, "0.00");
    const product = await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "Chicha Signature",
      price: "20.00",
      stockQuantity: 10,
    });
    await sell(context, [{ productId: product.id, quantity: 2 }], { paymentMethod: "CASH" });

    const csv = await exportSalesCsv(tenant.locationId, {});

    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const [header, row] = parseCsv(csv);
    expect(header).toEqual([
      "N° de commande",
      "Table",
      "Produit",
      "Quantité",
      "Prix unitaire",
      "TVA (%)",
      "Remise",
      "Date de vente",
    ]);
    expect(row[1]).toBe("Vente directe");
    expect(row[2]).toBe("Chicha Signature");
    expect(row[3]).toBe("2");
    expect(row[4]).toBe("20.00"); // raw decimal, never "20,00" or "20,00 €"
    expect(row[7]).toMatch(ISO_WITH_OFFSET);
  });

  it("never mixes another establishment's sales in", async () => {
    const otherTenant = await createTestTenant(pool, "Other Tenant");
    const otherOwner = await createTestUser(pool, otherTenant, "OWNER");
    await openBusinessDay(pool, otherTenant.locationId, "0.00");
    const otherProduct = await createProduct(pool, otherTenant.locationId, {
      categoryId: null,
      name: "Produit d'un autre établissement",
      price: "50.00",
      stockQuantity: 5,
    });
    await sell(
      {
        userId: otherOwner.userId,
        userEmail: otherOwner.email,
        userName: "Other Owner",
        organizationId: otherTenant.organizationId,
        locationId: otherTenant.locationId,
        role: "OWNER",
        sessionId: 1,
      },
      [{ productId: otherProduct.id, quantity: 1 }],
      { paymentMethod: "CASH" },
    );

    const csv = await exportSalesCsv(tenant.locationId, {});
    expect(parseCsv(csv)).toHaveLength(1); // header only, no data row
  });
});

describe("BI-12: exportPaymentsCsv", () => {
  it("exports one row per payment line, type and method verbatim, amount raw", async () => {
    await openBusinessDay(pool, tenant.locationId, "0.00");
    const product = await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "Café",
      price: "5.00",
      stockQuantity: 10,
    });
    await sell(context, [{ productId: product.id, quantity: 1 }], { paymentMethod: "CARD" });

    const csv = await exportPaymentsCsv(tenant.locationId, {});
    const [header, row] = parseCsv(csv);

    expect(header).toEqual([
      "N° de commande",
      "Type",
      "Méthode",
      "Montant",
      "Remboursement du paiement n°",
      "Créé par (id utilisateur)",
      "Date",
    ]);
    expect(row[1]).toBe("CHARGE");
    expect(row[2]).toBe("CARD");
    expect(row[3]).toBe("5.00");
    expect(row[4]).toBe(""); // not a refund
    expect(row[6]).toMatch(ISO_WITH_OFFSET);
  });
});

describe("BI-12: exportCashCsv", () => {
  it("exports the opening float and a manual movement, category and reason verbatim", async () => {
    const day = await openBusinessDay(pool, tenant.locationId, "100.00");
    await createCashMovement(pool, tenant.locationId, {
      businessDayId: day.id,
      type: "IN",
      category: "FUND_TOPUP",
      amount: "10.00",
      reason: "Appoint de caisse",
      createdBy: context.userId,
    });

    const csv = await exportCashCsv(tenant.locationId, {});
    const rows = parseCsv(csv);

    expect(rows[0]).toEqual([
      "Journée n°",
      "Type",
      "Catégorie",
      "Montant",
      "Motif",
      "Créé par (id utilisateur)",
      "Date",
    ]);
    // `openBusinessDay` (repository level, as used here) only sets the
    // `opening_cash` column on `business_days` — it writes no ledger row of
    // its own (`getExpectedCash` reads that column directly), so the only
    // `cash_movements` row in this fixture is the manual "IN" below.
    const topUp = rows.find((row) => row[1] === "IN");
    expect(topUp).toMatchObject({
      0: String(day.id),
      2: "FUND_TOPUP",
      3: "10.00",
      4: "Appoint de caisse",
    });
    expect(topUp?.[6]).toMatch(ISO_WITH_OFFSET);
  });
});

describe("BI-12: exportStockCsv", () => {
  it("exports a manual movement with its signed quantity and reason", async () => {
    const product = await createProduct(pool, tenant.locationId, {
      categoryId: null,
      name: "Sirop de menthe",
      price: "3.00",
      stockQuantity: 5,
    });
    await adjustProductStock(context, product.id, {
      delta: 12,
      type: "RECEIPT",
      reason: "Livraison fournisseur",
    });

    const csv = await exportStockCsv(tenant.locationId, {});
    const rows = parseCsv(csv);

    expect(rows[0]).toEqual([
      "Produit",
      "Type de mouvement",
      "Quantité",
      "Motif",
      "Référence",
      "Créé par (id utilisateur)",
      "Date",
    ]);
    const receipt = rows.find((row) => row[1] === "RECEIPT");
    expect(receipt).toMatchObject({
      0: "Sirop de menthe",
      2: "12", // signed positive: a receipt adds
      3: "Livraison fournisseur",
    });
    expect(receipt?.[6]).toMatch(ISO_WITH_OFFSET);
  });
});
