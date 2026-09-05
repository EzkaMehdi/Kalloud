import { withTransaction } from "../db";
import { ConflictError, ValidationError, isUniqueViolation } from "../errors";
import { recordAuditEvent } from "../audit";
import { fromCents } from "../money";
import { createCategory, updateCategory, type CategoryRow } from "../repositories/categories";
import { updateProduct, type ProductRow } from "../repositories/products";
import {
  createTaxClass,
  getLocationProfile,
  getLocationSettings,
  listTaxClasses,
  renameLocation,
  updateLocationSettings,
  type LocationSettings,
  type TaxClass,
} from "../repositories/settings";
import {
  createDiningTable,
  listAllDiningTables,
  renameDiningTable,
  reorderDiningTables,
  setDiningTableActive,
  type DiningTableRow,
} from "../repositories/tables";
import { isValidTimeZone } from "../time";
import type { RequestContext } from "../context";
import type {
  CategoryBody,
  CreateTaxClassBody,
  CreateDiningTableBody,
  ReorderTablesBody,
  UpdateProductBody,
  UpdateSettingsBody,
  UpdateTableActiveBody,
} from "../validation/schemas";

/**
 * Phase 4B: what an owner or manager configures without touching SQL.
 *
 * Every mutation here is audited. That is not decoration — GATE-4B asks for
 * an establishment that can be configured, and CFG-02/CFG-03 both name
 * "changements audités" in their acceptance: a price that changed with no
 * record of who changed it is exactly the gap the audit log exists to close.
 */

export interface EstablishmentConfiguration {
  name: string;
  settings: LocationSettings;
  taxClasses: TaxClass[];
}

export async function getConfiguration(
  context: RequestContext,
): Promise<EstablishmentConfiguration> {
  return withTransaction(async (client) => ({
    name: (await getLocationProfile(client, context.locationId)).name,
    settings: await getLocationSettings(client, context.locationId),
    taxClasses: await listTaxClasses(client, context.locationId),
  }));
}

/**
 * CFG-01: the establishment's name, timezone, currency, fallback tax rate
 * and cash-discrepancy threshold.
 *
 * Name and settings live in two tables, so the write is one transaction —
 * a half-applied settings change would leave the establishment describing
 * itself inconsistently.
 */
export async function updateConfiguration(
  context: RequestContext,
  input: UpdateSettingsBody,
): Promise<EstablishmentConfiguration> {
  // Checked here rather than in the schema: whether a zone exists is a
  // property of the runtime's ICU data, not of the request's shape, and
  // hard-coding a list would go stale.
  if (!isValidTimeZone(input.timezone)) {
    throw new ValidationError(`Fuseau horaire inconnu : "${input.timezone}".`);
  }

  return withTransaction(async (client) => {
    const before = {
      name: (await getLocationProfile(client, context.locationId)).name,
      settings: await getLocationSettings(client, context.locationId),
    };

    await renameLocation(client, context.locationId, input.name);
    const settings = await updateLocationSettings(client, context.locationId, {
      timezone: input.timezone,
      currency: input.currency,
      defaultTaxRate: fromCents(input.defaultTaxRate),
      cashDiscrepancyThreshold: fromCents(input.cashDiscrepancyThreshold),
    });

    await recordAuditEvent(client, {
      locationId: context.locationId,
      actorUserId: context.userId,
      action: "settings.update",
      targetType: "location",
      targetId: context.locationId,
      before,
      after: { name: input.name, settings },
    });

    return {
      name: input.name,
      settings,
      taxClasses: await listTaxClasses(client, context.locationId),
    };
  });
}

export async function addTaxClass(
  context: RequestContext,
  input: CreateTaxClassBody,
): Promise<TaxClass> {
  return withTransaction(async (client) => {
    let created: TaxClass;
    try {
      created = await createTaxClass(client, context.locationId, {
        name: input.name,
        rate: fromCents(input.rate),
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError("Une classe fiscale porte déjà ce nom.");
      }
      throw error;
    }

    await recordAuditEvent(client, {
      locationId: context.locationId,
      actorUserId: context.userId,
      action: "tax_class.create",
      targetType: "tax_class",
      targetId: created.id,
      after: { name: created.name, rate: created.rate },
    });
    return created;
  });
}

/* -------------------------------------------------------------------------- */
/* CFG-02 — catalogue                                                          */
/* -------------------------------------------------------------------------- */

export async function addCategory(
  context: RequestContext,
  input: CategoryBody,
): Promise<CategoryRow> {
  return withTransaction(async (client) => {
    let created: CategoryRow;
    try {
      created = await createCategory(client, context.locationId, {
        name: input.name,
        taxClassId: input.taxClassId ?? null,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError("Une catégorie porte déjà ce nom.");
      }
      throw error;
    }

    await recordAuditEvent(client, {
      locationId: context.locationId,
      actorUserId: context.userId,
      action: "category.create",
      targetType: "category",
      targetId: created.id,
      after: created,
    });
    return created;
  });
}

export async function editCategory(
  context: RequestContext,
  categoryId: number,
  input: CategoryBody,
): Promise<CategoryRow> {
  return withTransaction(async (client) => {
    const updated = await updateCategory(client, context.locationId, categoryId, {
      name: input.name,
      taxClassId: input.taxClassId ?? null,
    });
    await recordAuditEvent(client, {
      locationId: context.locationId,
      actorUserId: context.userId,
      action: "category.update",
      targetType: "category",
      targetId: categoryId,
      after: updated,
    });
    return updated;
  });
}

/**
 * CFG-02: a product's price, category, tax class, unit, threshold and
 * activation.
 *
 * Deactivating rather than deleting is what makes "produit désactivé absent
 * de la caisse mais conservé dans l'historique" possible: past order lines
 * keep pointing at the row, so a receipt printed a year from now still names
 * what was sold.
 */
export async function editProduct(
  context: RequestContext,
  productId: number,
  input: UpdateProductBody,
): Promise<ProductRow> {
  return withTransaction(async (client) => {
    const updated = await updateProduct(client, context.locationId, productId, {
      ...input,
      price: input.price === undefined ? undefined : fromCents(input.price),
    });

    await recordAuditEvent(client, {
      locationId: context.locationId,
      actorUserId: context.userId,
      action: "product.update",
      targetType: "product",
      targetId: productId,
      after: { changed: Object.keys(input), price: updated.price, isActive: updated.is_active },
    });
    return updated;
  });
}

/* -------------------------------------------------------------------------- */
/* CFG-03 — plan de salle                                                      */
/* -------------------------------------------------------------------------- */

export async function addDiningTable(
  context: RequestContext,
  input: CreateDiningTableBody,
): Promise<DiningTableRow> {
  return withTransaction(async (client) => {
    let created: DiningTableRow;
    try {
      created = await createDiningTable(client, context.locationId, input.name);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError("Une table porte déjà ce nom.");
      }
      throw error;
    }
    await recordAuditEvent(client, {
      locationId: context.locationId,
      actorUserId: context.userId,
      action: "table.create",
      targetType: "dining_table",
      targetId: created.id,
      after: { name: created.name },
    });
    return created;
  });
}

export async function editDiningTableName(
  context: RequestContext,
  tableId: number,
  name: string,
): Promise<DiningTableRow> {
  return withTransaction(async (client) => {
    const updated = await renameDiningTable(client, context.locationId, tableId, name);
    await recordAuditEvent(client, {
      locationId: context.locationId,
      actorUserId: context.userId,
      action: "table.rename",
      targetType: "dining_table",
      targetId: tableId,
      after: { name },
    });
    return updated;
  });
}

export async function setDiningTableActivation(
  context: RequestContext,
  tableId: number,
  input: UpdateTableActiveBody,
): Promise<DiningTableRow> {
  return withTransaction(async (client) => {
    const updated = await setDiningTableActive(client, context.locationId, tableId, input.isActive);
    await recordAuditEvent(client, {
      locationId: context.locationId,
      actorUserId: context.userId,
      action: input.isActive ? "table.activate" : "table.deactivate",
      targetType: "dining_table",
      targetId: tableId,
      after: { isActive: input.isActive },
    });
    return updated;
  });
}

export async function reorderTables(
  context: RequestContext,
  input: ReorderTablesBody,
): Promise<DiningTableRow[]> {
  return withTransaction(async (client) => {
    await reorderDiningTables(client, context.locationId, input.orderedIds);
    await recordAuditEvent(client, {
      locationId: context.locationId,
      actorUserId: context.userId,
      action: "table.reorder",
      targetType: "dining_table",
      targetId: null,
      after: { orderedIds: input.orderedIds },
    });
    return listAllDiningTables(client, context.locationId);
  });
}
