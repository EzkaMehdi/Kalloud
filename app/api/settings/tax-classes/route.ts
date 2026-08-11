import type { NextRequest } from "next/server";
import { requirePermission } from "@/lib/authz";
import { requireRequestContext } from "@/lib/context";
import { apiRoute, jsonOk } from "@/lib/http";
import { addTaxClass } from "@/lib/services/configuration";
import { parseJsonBody } from "@/lib/validation/parse";
import { createTaxClassSchema } from "@/lib/validation/schemas";

/** CFG-01: tax classes are part of defining the establishment, so OWNER only. */
export const POST = apiRoute(async (request: NextRequest) => {
  const context = await requireRequestContext();
  requirePermission(context.role, "settings:manage");
  const body = await parseJsonBody(request, createTaxClassSchema);
  return jsonOk(await addTaxClass(context, body), { status: 201 });
});
