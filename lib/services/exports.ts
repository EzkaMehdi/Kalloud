import { pool } from "../db";
import { toCsv } from "../csv";
import { listSoldItems, type SoldItemFilters } from "../repositories/orders";
import { listPaymentsHistory, type PaymentHistoryFilters } from "../repositories/payments";
import {
  listCashMovementsHistory,
  type CashMovementHistoryFilters,
} from "../repositories/cash-movements";
import {
  listStockMovementsHistory,
  type StockMovementHistoryFilters,
} from "../repositories/stock-movements";
import { getLocationSettings } from "../repositories/settings";
import { resolvePeriodRange, type MetricsQuery } from "./metrics";
import { formatZonedIso } from "../time";

/**
 * BI-12: "exports ventes, paiements, caisse et stock" — `DEC-09`'s own
 * four validated domains, each built on the exact repository function
 * `BI-02` already wrote and tested for the same domain's *paginated* JSON
 * history (`listSoldItems`, `listPaymentsHistory`,
 * `listCashMovementsHistory`, `listStockMovementsHistory`) — never a second
 * query. The only new thing each of those four functions gained (`BI-12`,
 * `lib/db.ts::buildLimitOffsetClause`) is answering "every matching row"
 * when `limit`/`offset` are both omitted, which is all a CSV export ever
 * asks for — there is no "next page" of a file someone just downloaded.
 *
 * BI-14: "l'export respecte exactement les filtres" (`GATE-6`) — each
 * function below now takes the cockpit's own `MetricsQuery` (service/day/
 * month/year/range) rather than a raw, unscoped `{from, to}`: clicking
 * "Ventes" while the cockpit shows "Ce mois" exports that month, not the
 * establishment's whole history, resolved via `resolvePeriodRange` (`BI-11`/
 * `BI-14`) — the same window the KPI cards and the trends block used for
 * the same query, never a fifth formula that could disagree. `null`
 * (`period: "service"` with nothing open) is a real, valid file — the
 * header row alone, not an error — the same honest-empty answer
 * `getSalesTrendsForPeriod` gives the trends block for the same case.
 *
 * Column headers are French and amounts/dates follow `DEC-09`'s CSV format
 * exactly (`lib/csv.ts`, `lib/time.ts::formatZonedIso`) — this module's own
 * job is only choosing which columns each domain exports and in what order,
 * never reformatting a value `DEC-09` already specified the shape of.
 *
 * None of the four join out to a human name for `created_by` (a bare user
 * id): none of the `BI-02` repository rows carry one, and adding that join
 * here — for the export's convenience alone — would be a second,
 * export-only definition of "who did this" alongside the one every other
 * screen already reads a different way. Honest about what the data actually
 * is, not a fabricated name.
 */

const eur = (value: string) => value; // Already DEC-09's own raw-decimal shape ("12.50") — passed through, never reformatted.

/** `null` when the query resolves to no window at all (`period: "service"`, nothing open). */
async function resolveIsoRange(
  locationId: number,
  query: MetricsQuery,
): Promise<{ from: string; to: string } | null> {
  const range = await resolvePeriodRange(locationId, query);
  if (range === null) return null;
  return { from: range.from.toISOString(), to: range.to.toISOString() };
}

export async function exportSalesCsv(locationId: number, query: MetricsQuery): Promise<string> {
  const headers = [
    "N° de commande",
    "Table",
    "Produit",
    "Quantité",
    "Prix unitaire",
    "TVA (%)",
    "Remise",
    "Date de vente",
  ];
  const range = await resolveIsoRange(locationId, query);
  if (range === null) return toCsv(headers, []);

  const timezone = await zoneOf(locationId);
  const filters: SoldItemFilters = { from: range.from, to: range.to };
  const { items } = await listSoldItems(pool, locationId, filters);

  return toCsv(
    headers,
    items.map((item) => [
      String(item.order_number),
      item.table_name ?? "Vente directe",
      item.product_name,
      String(item.quantity),
      eur(item.unit_price),
      item.tax_rate_percent ?? "",
      eur(item.discount_amount),
      formatZonedIso(new Date(item.sold_at), timezone),
    ]),
  );
}

export async function exportPaymentsCsv(locationId: number, query: MetricsQuery): Promise<string> {
  const headers = [
    "N° de commande",
    "Type",
    "Méthode",
    "Montant",
    "Remboursement du paiement n°",
    "Créé par (id utilisateur)",
    "Date",
  ];
  const range = await resolveIsoRange(locationId, query);
  if (range === null) return toCsv(headers, []);

  const timezone = await zoneOf(locationId);
  const filters: PaymentHistoryFilters = { from: range.from, to: range.to };
  const { payments } = await listPaymentsHistory(pool, locationId, filters);

  return toCsv(
    headers,
    payments.map((payment) => [
      String(payment.order_number),
      payment.type,
      payment.method,
      eur(payment.amount),
      payment.refunded_payment_id !== null ? String(payment.refunded_payment_id) : "",
      String(payment.created_by),
      formatZonedIso(new Date(payment.created_at), timezone),
    ]),
  );
}

export async function exportCashCsv(locationId: number, query: MetricsQuery): Promise<string> {
  const headers = [
    "Journée n°",
    "Type",
    "Catégorie",
    "Montant",
    "Motif",
    "Créé par (id utilisateur)",
    "Date",
  ];
  const range = await resolveIsoRange(locationId, query);
  if (range === null) return toCsv(headers, []);

  const timezone = await zoneOf(locationId);
  const filters: CashMovementHistoryFilters = { from: range.from, to: range.to };
  const { movements } = await listCashMovementsHistory(pool, locationId, filters);

  return toCsv(
    headers,
    movements.map((movement) => [
      movement.business_day_id !== null ? String(movement.business_day_id) : "",
      movement.type,
      movement.category,
      eur(movement.amount),
      movement.reason,
      String(movement.created_by),
      formatZonedIso(new Date(movement.created_at), timezone),
    ]),
  );
}

export async function exportStockCsv(locationId: number, query: MetricsQuery): Promise<string> {
  const headers = [
    "Produit",
    "Type de mouvement",
    "Quantité",
    "Motif",
    "Référence",
    "Créé par (id utilisateur)",
    "Date",
  ];
  const range = await resolveIsoRange(locationId, query);
  if (range === null) return toCsv(headers, []);

  const timezone = await zoneOf(locationId);
  const filters: StockMovementHistoryFilters = { from: range.from, to: range.to };
  const { movements } = await listStockMovementsHistory(pool, locationId, filters);

  return toCsv(
    headers,
    movements.map((movement) => [
      movement.product_name,
      movement.type,
      String(movement.quantity),
      movement.reason,
      movement.reference_type !== null && movement.reference_id !== null
        ? `${movement.reference_type}:${movement.reference_id}`
        : "",
      String(movement.created_by),
      formatZonedIso(new Date(movement.created_at), timezone),
    ]),
  );
}

async function zoneOf(locationId: number): Promise<string> {
  const settings = await getLocationSettings(pool, locationId);
  return settings.timezone;
}
