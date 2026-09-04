import type { Queryable } from "../db";

/**
 * OPS-02: the operational facts that live in the database rather than in
 * the process — services left open, closings, cash variances.
 *
 * Deliberately **not** location-scoped, and the only repository besides
 * `users.ts` that is not. Every other one takes `locationId` first because
 * it serves an establishment's own screens (SEC-06); these serve the
 * operator's monitoring, whose whole question is "is anything wrong
 * *anywhere*". Nothing here reaches a business surface: the single caller
 * is `lib/services/operations.ts`, behind an endpoint gated by an operator
 * token, and the rows returned carry no customer, product or money detail
 * beyond the variance the alert is about.
 */

export interface StaleOpenBusinessDayRow {
  location_id: number;
  opened_at: string;
  hours_open: number;
}

export async function listStaleOpenBusinessDays(
  db: Queryable,
  hours: number,
): Promise<StaleOpenBusinessDayRow[]> {
  const { rows } = await db.query<StaleOpenBusinessDayRow>(
    `SELECT location_id,
            opened_at,
            FLOOR(EXTRACT(EPOCH FROM (now() - opened_at)) / 3600)::INT AS hours_open
       FROM business_days
      WHERE status = 'OPEN'
        AND opened_at < now() - make_interval(hours => $1)
      ORDER BY opened_at ASC`,
    [hours],
  );
  return rows;
}

export interface UnexplainedVarianceRow {
  location_id: number;
  business_day_id: number;
  cash_variance: string;
}

/**
 * Closings whose variance exceeded the establishment's own threshold and
 * carry no reason.
 *
 * The threshold is read per establishment (`location_settings`, CFG-01)
 * rather than fixed here: a food truck and a brasserie do not mean the same
 * thing by "a significant gap", and hard-coding one number would alert one
 * of them constantly and the other never. `CASH-05` already refuses such a
 * closing at the point of entry, so a row coming back here is either older
 * than that rule or written another way — which is exactly what an
 * operational check is for.
 */
export async function listUnexplainedVariances(
  db: Queryable,
  since: Date,
): Promise<UnexplainedVarianceRow[]> {
  const { rows } = await db.query<UnexplainedVarianceRow>(
    `SELECT d.location_id, d.id AS business_day_id, d.cash_variance::TEXT AS cash_variance
       FROM business_days d
       JOIN location_settings s ON s.location_id = d.location_id
      WHERE d.status = 'CLOSED'
        AND d.closed_at >= $1
        AND d.cash_variance IS NOT NULL
        AND ABS(d.cash_variance) > s.cash_discrepancy_threshold
        AND (d.variance_reason IS NULL OR btrim(d.variance_reason) = '')
      ORDER BY d.closed_at DESC`,
    [since],
  );
  return rows;
}

export async function countClosingsSince(db: Queryable, since: Date): Promise<number> {
  const { rows } = await db.query<{ count: string }>(
    `SELECT COUNT(*)::TEXT AS count FROM business_days
      WHERE status = 'CLOSED' AND closed_at >= $1`,
    [since],
  );
  return Number(rows[0].count);
}
