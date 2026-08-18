import { pool } from "../db";
import { formatMoney, toCents } from "../money";
import { getActiveBusinessDay, getLastClosedBusinessDay } from "../repositories/business-days";
import { listCashMovements } from "../repositories/cash-movements";
import { listProducts } from "../repositories/products";
import { getLocationSettings } from "../repositories/settings";
import { listOpenTickets } from "../repositories/tickets";
import type { RequestContext } from "../context";

/**
 * BI-06: "au maximum trois à cinq actions" (VISION_PRODUIT_ET_AUDIT.md §10),
 * fixed by the task's own acceptance at exactly five — the five named by
 * the livrable, each collapsed to **one row per type** rather than one row
 * per affected entity. Three products out of stock is one alert ("3
 * produits en rupture"), not three; that is what keeps "maximum cinq"
 * meaningful instead of an arbitrary truncation of a longer list.
 *
 * Every detection below reuses a query this codebase already trusts for
 * something else — no second implementation of "is this product low on
 * stock" or "what is today's cash discrepancy threshold" is introduced
 * here, for the same reason `BI-01` reused `getBusinessDaySummary` instead
 * of recomputing revenue: two answers to the same question is how they
 * quietly disagree.
 *
 * "Chacune ouvre l'action correspondante" is honoured at the granularity
 * the product's screens actually support today: a link to the screen where
 * that action is performed (`/stock`, `/caisse`, `/bilan`). None of those
 * screens currently accepts a query parameter to preselect one product,
 * table or ticket — building that is a screen-level change no task has
 * asked for yet, so the alert opens the right screen, not (yet) the exact
 * row within it.
 */

export type AlertType = "stock" | "cash_variance" | "stale_ticket" | "anomaly" | "late_closing";

export interface Alert {
  type: AlertType;
  severity: "critical" | "warning";
  message: string;
  actionLabel: string;
  actionHref: string;
}

/** How long a ticket may sit `OPEN` before it is worth a manager's attention rather than a customer's. */
const STALE_TICKET_HOURS = 3;
/** How long a service may run before "still open" starts to look like "forgotten". */
const LATE_CLOSING_HOURS = 16;

// VISION_PRODUIT_ET_AUDIT.md §10's own listed order — rupture first (it
// blocks a sale outright), an unexplained closing last (already frozen,
// nothing about it gets worse while it waits to be reviewed).
const ALERT_PRIORITY: readonly AlertType[] = [
  "stock",
  "cash_variance",
  "stale_ticket",
  "anomaly",
  "late_closing",
];

export async function getAlerts(context: RequestContext): Promise<Alert[]> {
  const { locationId } = context;
  const alerts: Alert[] = [];

  // 1. Rupture ou stock sous seuil (DEC-09's own alert definitions, one row
  // for both together — a manager opens the same screen for either).
  const products = await listProducts(pool, locationId);
  const outOfStock = products.filter(
    (product) => product.is_active && product.stock_quantity === 0,
  );
  const lowStock = products.filter(
    (product) =>
      product.is_active &&
      product.stock_quantity > 0 &&
      product.stock_quantity <= product.alert_threshold,
  );
  if (outOfStock.length > 0 || lowStock.length > 0) {
    const parts = [
      outOfStock.length > 0 ? `${outOfStock.length} en rupture` : null,
      lowStock.length > 0 ? `${lowStock.length} sous le seuil` : null,
    ].filter((part): part is string => part !== null);
    alerts.push({
      type: "stock",
      severity: outOfStock.length > 0 ? "critical" : "warning",
      message: `${parts.join(", ")} — ${outOfStock.length + lowStock.length} produit(s) au total`,
      actionLabel: "Voir le stock",
      actionHref: "/stock",
    });
  }

  // 2. Écart de caisse à la dernière clôture, comparé au seuil de CFG-00 —
  // la même comparaison que CASH-05 impose déjà à la clôture elle-même.
  const lastClosed = await getLastClosedBusinessDay(pool, locationId);
  if (lastClosed?.cash_variance !== null && lastClosed?.cash_variance !== undefined) {
    const settings = await getLocationSettings(pool, locationId);
    const varianceCents = toCents(lastClosed.cash_variance);
    const thresholdCents = Math.round(settings.cashDiscrepancyThreshold * 100);
    if (Math.abs(varianceCents) > thresholdCents) {
      alerts.push({
        type: "cash_variance",
        severity: "warning",
        message: `Écart de ${formatMoney(Math.abs(varianceCents))} à la dernière clôture`,
        actionLabel: "Voir la caisse",
        actionHref: "/caisse",
      });
    }
  }

  const activeDay = await getActiveBusinessDay(pool, locationId);

  // 3. Ticket ouvert depuis trop longtemps.
  const openTickets = await listOpenTickets(pool, locationId);
  const staleTickets = openTickets.filter(
    (ticket) => Date.now() - new Date(ticket.created_at).getTime() > STALE_TICKET_HOURS * 3_600_000,
  );
  if (staleTickets.length > 0) {
    alerts.push({
      type: "stale_ticket",
      severity: "warning",
      message: `${staleTickets.length} ticket(s) ouvert(s) depuis plus de ${STALE_TICKET_HOURS} h`,
      actionLabel: "Voir la salle",
      actionHref: "/caisse",
    });
  }

  // 4. Paiement ou mouvement anormal — lu ici comme un mouvement de caisse
  // dont la catégorie est restée générique (`OTHER`, DEC-11) : la
  // catégorisation existe précisément pour que ce cas reste rare, donc son
  // apparition est le signal, pas une supposition sur un montant inhabituel.
  if (activeDay) {
    const movements = await listCashMovements(pool, locationId, { businessDayId: activeDay.id });
    const uncategorised = movements.filter((movement) => movement.category === "OTHER");
    if (uncategorised.length > 0) {
      alerts.push({
        type: "anomaly",
        severity: "warning",
        message: `${uncategorised.length} mouvement(s) de caisse sans catégorie précise`,
        actionLabel: "Voir le journal",
        actionHref: "/bilan",
      });
    }
  }

  // 5. Clôture en retard.
  if (activeDay) {
    const openHours = (Date.now() - new Date(activeDay.opened_at).getTime()) / 3_600_000;
    if (openHours > LATE_CLOSING_HOURS) {
      alerts.push({
        type: "late_closing",
        severity: "critical",
        message: `Service ouvert depuis plus de ${LATE_CLOSING_HOURS} h`,
        actionLabel: "Clôturer le service",
        actionHref: "/caisse",
      });
    }
  }

  // Defensive, not load-bearing today: exactly one row per type above, and
  // exactly five types exist. Keeps "maximum cinq" true by construction
  // even if a sixth type is ever added without updating this line.
  return alerts
    .sort((a, b) => ALERT_PRIORITY.indexOf(a.type) - ALERT_PRIORITY.indexOf(b.type))
    .slice(0, 5);
}
