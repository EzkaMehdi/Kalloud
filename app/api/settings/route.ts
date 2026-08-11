import type { NextRequest } from "next/server";
import { requirePermission } from "@/lib/authz";
import { requireRequestContext } from "@/lib/context";
import { apiRoute, jsonOk } from "@/lib/http";
import { getConfiguration, updateConfiguration } from "@/lib/services/configuration";
import { parseJsonBody } from "@/lib/validation/parse";
import { updateSettingsSchema } from "@/lib/validation/schemas";

/**
 * CFG-01: the establishment's settings.
 *
 * Readable by anyone with a session — the caisse needs the currency and the
 * cash screen needs the discrepancy threshold, and hiding them from a
 * cashier would only mean hard-coding them again somewhere. Writing is
 * `settings:manage`, which DEC-07 gives to the OWNER alone: a manager runs
 * the establishment, the owner defines it.
 */
export const GET = apiRoute(async () => {
  const context = await requireRequestContext();
  return jsonOk(await getConfiguration(context));
});

export const PUT = apiRoute(async (request: NextRequest) => {
  const context = await requireRequestContext();
  requirePermission(context.role, "settings:manage");
  const body = await parseJsonBody(request, updateSettingsSchema);
  return jsonOk(await updateConfiguration(context, body));
});
