import type { NextRequest } from "next/server";
import { confirmPasswordReset } from "@/lib/auth/service";
import { ValidationError } from "@/lib/errors";
import { apiRoute, jsonOk, readJsonBody } from "@/lib/http";

interface ConfirmBody {
  token?: string;
  password?: string;
}

export const POST = apiRoute(async (request: NextRequest) => {
  const body = await readJsonBody<ConfirmBody>(request);
  if (!body.token) {
    throw new ValidationError("Jeton de réinitialisation manquant.");
  }
  await confirmPasswordReset(body.token, body.password ?? "");
  return jsonOk({ ok: true });
});
