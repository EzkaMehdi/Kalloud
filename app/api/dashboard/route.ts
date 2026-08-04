import type { NextRequest } from "next/server";
import { requirePermission } from "@/lib/authz";
import { requireRequestContext } from "@/lib/context";
import { apiRoute, jsonOk } from "@/lib/http";
import { getDashboardSummary, type DashboardPeriod } from "@/lib/services/dashboard";

const VALID_PERIODS: readonly DashboardPeriod[] = ["day", "month", "year"];

export const GET = apiRoute(async (request: NextRequest) => {
  const context = await requireRequestContext();
  requirePermission(context.role, "dashboard:view");

  const { searchParams } = new URL(request.url);
  const periodParam = searchParams.get("period");
  const period: DashboardPeriod = VALID_PERIODS.includes(periodParam as DashboardPeriod)
    ? (periodParam as DashboardPeriod)
    : "day";
  const year = searchParams.has("year") ? Number(searchParams.get("year")) : undefined;
  const month = searchParams.has("month") ? Number(searchParams.get("month")) : undefined;

  const summary = await getDashboardSummary(context.locationId, { period, year, month });
  return jsonOk(summary);
});
