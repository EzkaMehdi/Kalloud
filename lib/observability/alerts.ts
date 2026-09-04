import type { ProcessSnapshot } from "./collector";

/**
 * OPS-02: "seuils et destinataires définis ; aucun bruit excessif."
 *
 * The thresholds live here, as data, for the same reason DEC-07's
 * permission matrix lives in `lib/authz.ts` rather than only in its
 * decision document: a threshold written only in prose is a threshold
 * nobody evaluates. `docs/exploitation.md` carries the reasoning; this
 * table is what actually fires.
 *
 * Two rules keep the noise down, and they are the whole difference between
 * an alert someone reads and an alert everyone mutes:
 *
 * - **Nothing fires on a business refusal.** 4xx is the product working
 *   (see `collector.ts::classify`). Only 5xx, an unreachable database, and
 *   operational facts about the establishment's own day can page anyone.
 * - **Nothing fires below a minimum volume.** One 500 out of the two
 *   requests served at 6am is a 50 % error rate and not an incident. Every
 *   rate-based rule states the sample size it needs before it is allowed to
 *   speak.
 */

export type Severity = "critical" | "warning";

/**
 * Who is woken up. There is one operator for the pilot (DEC-01 scopes the
 * MVP to a single establishment), so the split is by *kind of problem*
 * rather than by team: what only the operator can fix versus what only the
 * establishment can.
 */
export type Recipient = "astreinte" | "etablissement";

export interface OpsAlert {
  id: string;
  severity: Severity;
  recipient: Recipient;
  /** What fired, in the words the recipient needs — not the metric's name. */
  message: string;
  /** The number that fired it and the number it had to beat, for a reader who disagrees. */
  observed: string;
  threshold: string;
}

export interface OperationalFacts {
  /** False when the readiness probe's dependency (Postgres) is unreachable. */
  databaseReachable: boolean;
  /** Services still open well past any plausible one (DEC-04 allows crossing midnight). */
  staleOpenBusinessDays: { locationId: number; openedAt: string; hoursOpen: number }[];
  /** Closings whose counted cash missed the establishment's own threshold (CASH-05). */
  unexplainedVariances: { locationId: number; businessDayId: number; variance: string }[];
  /** Closings completed in the lookback window — context, never an alert by itself. */
  closingsInWindow: number;
  /**
   * OPS-03: age of the most recent usable backup, in hours; `null` when
   * there is none at all.
   */
  lastBackupAgeHours: number | null;
}

/** A rate is only allowed to fire once it has seen this many requests. */
export const MIN_REQUESTS_FOR_RATE = 20;
export const SERVER_ERROR_RATE_THRESHOLD = 0.01;
export const P95_LATENCY_THRESHOLD_MS = 1500;
/** DEC-04 lets a service cross midnight; 24h means nobody closed it. */
export const STALE_BUSINESS_DAY_HOURS = 24;
/**
 * OPS-03/DEC-10: the RPO. A backup older than this means more than a day of
 * trading could be lost, which is precisely what the target forbids. Checked
 * with a small grace margin so a scheduler that runs at 03:00 and drifts by
 * a few minutes does not page anyone every night.
 */
export const BACKUP_MAX_AGE_HOURS = 26;

export function evaluateAlerts(
  snapshot: ProcessSnapshot,
  facts: OperationalFacts,
): readonly OpsAlert[] {
  const alerts: OpsAlert[] = [];

  // Disponibilité. Not rate-gated: one unreachable database is an outage at
  // any hour, and the establishment cannot take a single payment through it.
  if (!facts.databaseReachable) {
    alerts.push({
      id: "database_unreachable",
      severity: "critical",
      recipient: "astreinte",
      message: "La base de données est injoignable : aucun encaissement n'est possible.",
      observed: "injoignable",
      threshold: "joignable",
    });
  }

  // Erreurs. 5xx only, and only once the sample is big enough to mean
  // anything.
  if (
    snapshot.requests >= MIN_REQUESTS_FOR_RATE &&
    snapshot.serverErrorRate > SERVER_ERROR_RATE_THRESHOLD
  ) {
    alerts.push({
      id: "server_error_rate",
      severity: "critical",
      recipient: "astreinte",
      message: "Trop d'erreurs serveur : quelque chose casse pour des utilisateurs.",
      observed: `${(snapshot.serverErrorRate * 100).toFixed(2)} % sur ${snapshot.requests} requêtes`,
      threshold: `${SERVER_ERROR_RATE_THRESHOLD * 100} %`,
    });
  }

  // Encaissements échoués. Separate from the global rate on purpose: a
  // checkout failing is money not taken, so it is worth its own line even
  // when it is a rounding error in the overall rate.
  const checkout = snapshot.routes.find((route) => route.route === "/api/checkout");
  if (checkout && checkout.serverErrors > 0) {
    alerts.push({
      id: "checkout_failures",
      severity: "critical",
      recipient: "astreinte",
      message: "Des encaissements ont échoué pour une erreur serveur : des ventes sont perdues.",
      observed: `${checkout.serverErrors} sur ${checkout.requests}`,
      threshold: "0",
    });
  }

  // Latence.
  if (snapshot.requests >= MIN_REQUESTS_FOR_RATE && snapshot.p95Ms > P95_LATENCY_THRESHOLD_MS) {
    alerts.push({
      id: "latency_p95",
      severity: "warning",
      recipient: "astreinte",
      message: "L'application répond lentement : le service en salle va s'en ressentir.",
      observed: `${snapshot.p95Ms} ms (p95)`,
      threshold: `${P95_LATENCY_THRESHOLD_MS} ms`,
    });
  }

  // Sauvegardes. DEC-10's RPO is only a target until something checks it:
  // an unverified backup schedule is discovered to have been broken on the
  // day it is needed, which is the one day it cannot be fixed.
  if (facts.lastBackupAgeHours === null) {
    alerts.push({
      id: "backup_missing",
      severity: "critical",
      recipient: "astreinte",
      message: "Aucune sauvegarde n'a été trouvée : le RPO de 24 h n'est pas tenu.",
      observed: "aucune",
      threshold: `${BACKUP_MAX_AGE_HOURS} h`,
    });
  } else if (facts.lastBackupAgeHours > BACKUP_MAX_AGE_HOURS) {
    alerts.push({
      id: "backup_overdue",
      severity: "critical",
      recipient: "astreinte",
      message: "La dernière sauvegarde est trop ancienne : le RPO de 24 h n'est plus tenu.",
      observed: `${facts.lastBackupAgeHours} h`,
      threshold: `${BACKUP_MAX_AGE_HOURS} h`,
    });
  }

  // Clôtures. Addressed to the establishment, not to on-call: nothing is
  // broken, someone forgot to close their service, and only they can.
  for (const day of facts.staleOpenBusinessDays) {
    alerts.push({
      id: `business_day_not_closed:${day.locationId}`,
      severity: "warning",
      recipient: "etablissement",
      message:
        "Un service est ouvert depuis plus d'une journée : il n'a probablement pas été clôturé.",
      observed: `${day.hoursOpen} h (ouvert le ${day.openedAt})`,
      threshold: `${STALE_BUSINESS_DAY_HOURS} h`,
    });
  }

  // Écarts de caisse. A variance is not an incident — CASH-05 already
  // forces a reason above the establishment's threshold, and this only
  // reports the ones that got through without one.
  for (const variance of facts.unexplainedVariances) {
    alerts.push({
      id: `cash_variance_unexplained:${variance.businessDayId}`,
      severity: "warning",
      recipient: "etablissement",
      message: "Une clôture présente un écart de caisse hors seuil sans motif enregistré.",
      observed: `${variance.variance} €`,
      threshold: "seuil de l'établissement (CFG-01)",
    });
  }

  return alerts;
}
