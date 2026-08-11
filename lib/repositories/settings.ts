import type { Queryable } from "../db";
import { NotFoundError } from "../errors";

export interface LocationSettings {
  locationId: number;
  timezone: string;
  currency: string;
  defaultTaxRate: number;
  cashDiscrepancyThreshold: number;
}

interface LocationSettingsRow {
  location_id: number;
  timezone: string;
  currency: string;
  default_tax_rate: string;
  cash_discrepancy_threshold: string;
}

function mapSettings(row: LocationSettingsRow): LocationSettings {
  return {
    locationId: row.location_id,
    timezone: row.timezone,
    currency: row.currency,
    defaultTaxRate: Number(row.default_tax_rate),
    cashDiscrepancyThreshold: Number(row.cash_discrepancy_threshold),
  };
}

/** CFG-00: the business settings that must exist before any financial calculation runs. */
export async function getLocationSettings(
  db: Queryable,
  locationId: number,
): Promise<LocationSettings> {
  const { rows } = await db.query<LocationSettingsRow>(
    `SELECT location_id, timezone, currency, default_tax_rate, cash_discrepancy_threshold
     FROM location_settings WHERE location_id = $1`,
    [locationId],
  );
  const row = rows[0];
  if (!row) throw new NotFoundError("Réglages de l'établissement introuvables.");
  return mapSettings(row);
}

export interface TaxClass {
  id: number;
  locationId: number;
  name: string;
  rate: number;
  isDefault: boolean;
}

interface TaxClassRow {
  id: number;
  location_id: number;
  name: string;
  rate: string;
  is_default: boolean;
}

function mapTaxClass(row: TaxClassRow): TaxClass {
  return {
    id: row.id,
    locationId: row.location_id,
    name: row.name,
    rate: Number(row.rate),
    isDefault: row.is_default,
  };
}

export async function listTaxClasses(db: Queryable, locationId: number): Promise<TaxClass[]> {
  const { rows } = await db.query<TaxClassRow>(
    "SELECT id, location_id, name, rate, is_default FROM tax_classes WHERE location_id = $1 ORDER BY name",
    [locationId],
  );
  return rows.map(mapTaxClass);
}

/** CFG-01: the establishment's own identity, which lives on `locations`, not on its settings row. */
export interface LocationProfile {
  id: number;
  name: string;
}

export async function getLocationProfile(
  db: Queryable,
  locationId: number,
): Promise<LocationProfile> {
  const { rows } = await db.query<LocationProfile>("SELECT id, name FROM locations WHERE id = $1", [
    locationId,
  ]);
  const row = rows[0];
  if (!row) throw new NotFoundError("Établissement introuvable.");
  return row;
}

export async function renameLocation(
  db: Queryable,
  locationId: number,
  name: string,
): Promise<void> {
  await db.query("UPDATE locations SET name = $2 WHERE id = $1", [locationId, name]);
}

export interface UpdateSettingsInput {
  timezone: string;
  currency: string;
  /** Percentage with two decimals, as a DECIMAL-shaped string. */
  defaultTaxRate: string;
  cashDiscrepancyThreshold: string;
}

export async function updateLocationSettings(
  db: Queryable,
  locationId: number,
  input: UpdateSettingsInput,
): Promise<LocationSettings> {
  const { rows } = await db.query<LocationSettingsRow>(
    `UPDATE location_settings
     SET timezone = $2, currency = $3, default_tax_rate = $4,
         cash_discrepancy_threshold = $5, updated_at = now()
     WHERE location_id = $1
     RETURNING location_id, timezone, currency, default_tax_rate, cash_discrepancy_threshold`,
    [
      locationId,
      input.timezone,
      input.currency,
      input.defaultTaxRate,
      input.cashDiscrepancyThreshold,
    ],
  );
  const row = rows[0];
  if (!row) throw new NotFoundError("Réglages de l'établissement introuvables.");
  return mapSettings(row);
}

export interface CreateTaxClassInput {
  name: string;
  /** Percentage with two decimals, as a DECIMAL-shaped string. */
  rate: string;
}

export async function createTaxClass(
  db: Queryable,
  locationId: number,
  input: CreateTaxClassInput,
): Promise<TaxClass> {
  const {
    rows: [row],
  } = await db.query<TaxClassRow>(
    `INSERT INTO tax_classes (location_id, name, rate) VALUES ($1, $2, $3)
     RETURNING id, location_id, name, rate, is_default`,
    [locationId, input.name, input.rate],
  );
  return mapTaxClass(row);
}
