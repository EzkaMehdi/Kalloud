import type { NextRequest } from "next/server";
import { confirmPasswordReset } from "@/lib/auth/service";
import { apiRoute, jsonOk } from "@/lib/http";
import { parseJsonBody } from "@/lib/validation/parse";
import { passwordResetConfirmSchema } from "@/lib/validation/schemas";

export const POST = apiRoute(async (request: NextRequest) => {
  const body = await parseJsonBody(request, passwordResetConfirmSchema);
  await confirmPasswordReset(body.token, body.password);
  return jsonOk({ ok: true });
});
