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
