import { pingDatabase, pool } from "../db";
import { logger } from "../logger";
import { evaluateAlerts, STALE_BUSINESS_DAY_HOURS, type OpsAlert } from "../observability/alerts";
import { snapshotProcess, type ProcessSnapshot } from "../observability/collector";
import {
  countClosingsSince,
  listStaleOpenBusinessDays,
  listUnexplainedVariances,
} from "../repositories/operations";

/**
 * OPS-02: one call that answers "is anything wrong", from the two places
 * the answer lives — the process (availability, latency, errors) and the
 * database (closings, cash variances).
 *
 * The window is fixed at 24 hours for the database side. A shorter one
 * would miss the service closed at 2am; a longer one would keep an
 * already-handled variance firing for days, which is the slow way an alert
 * becomes wallpaper.
 */
const LOOKBACK_HOURS = 24;

export interface OperationsReport {
  generatedAt: string;
  process: ProcessSnapshot;
  database: {
    reachable: boolean;
    lookbackHours: number;
    closings: number;
    openServicesOverdue: number;
    unexplainedVariances: number;
  };
  alerts: readonly OpsAlert[];
}

export async function getOperationsReport(): Promise<OperationsReport> {
  const snapshot = snapshotProcess();
  const since = new Date(Date.now() - LOOKBACK_HOURS * 3600 * 1000);

  let reachable = true;
  let staleOpenBusinessDays: Awaited<ReturnType<typeof listStaleOpenBusinessDays>> = [];
  let unexplained: Awaited<ReturnType<typeof listUnexplainedVariances>> = [];
  let closings = 0;

  try {
    await pingDatabase();
    [staleOpenBusinessDays, unexplained, closings] = await Promise.all([
      listStaleOpenBusinessDays(pool, STALE_BUSINESS_DAY_HOURS),
      listUnexplainedVariances(pool, since),
      countClosingsSince(pool, since),
    ]);
  } catch (error) {
    // An unreachable database must not take the monitoring endpoint down
    // with it: that is the exact moment someone is asking it what is
    // happening. The process-side numbers are still returned, and
    // `databaseReachable: false` becomes the critical alert.
    reachable = false;
    logger.error("operations report could not read the database", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  const alerts = evaluateAlerts(snapshot, {
    databaseReachable: reachable,
    staleOpenBusinessDays: staleOpenBusinessDays.map((day) => ({
      locationId: day.location_id,
      openedAt: day.opened_at,
      hoursOpen: day.hours_open,
    })),
    unexplainedVariances: unexplained.map((row) => ({
      locationId: row.location_id,
      businessDayId: row.business_day_id,
      variance: row.cash_variance,
    })),
    closingsInWindow: closings,
  });

  return {
    generatedAt: new Date().toISOString(),
    process: snapshot,
    database: {
      reachable,
      lookbackHours: LOOKBACK_HOURS,
      closings,
      openServicesOverdue: staleOpenBusinessDays.length,
      unexplainedVariances: unexplained.length,
    },
    alerts,
  };
}
