import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { UnauthenticatedError } from "@/lib/errors";
import { apiRoute, jsonOk } from "@/lib/http";
import { getOperationsReport } from "@/lib/services/operations";

/**
 * OPS-02: the operator's view — availability, latency, errors, failed
 * checkouts, closings and cash variances, with the alerts they cross.
 *
 * Sits under `/api/health` because it is an infra probe with no tenant: it
 * reports on every establishment at once, which is precisely why it is not
 * a business route and must never be reachable with an ordinary session.
 * Nothing in DEC-07 grants it — an owner administers their establishment,
 * not the platform — so it is gated by a shared operator secret rather than
 * by a role.
 *
 * Absent `OPS_METRICS_TOKEN`, the endpoint refuses rather than opening: a
 * cross-tenant report that falls back to "no auth configured, allow" is how
 * a monitoring endpoint becomes a data leak on the day someone forgets an
 * environment variable.
 */
export const GET = apiRoute(async (request: NextRequest) => {
  const expected = process.env.OPS_METRICS_TOKEN;
  if (!expected) {
    throw new UnauthenticatedError("Métriques d'exploitation non configurées.");
  }

  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!matches(presented, expected)) {
    throw new UnauthenticatedError("Jeton d'exploitation invalide.");
  }

  return jsonOk(await getOperationsReport());
});

/** Constant-time, and length-safe: timingSafeEqual throws on a length mismatch. */
function matches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
