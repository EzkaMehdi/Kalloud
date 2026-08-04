import type { NextRequest } from "next/server";
import { requestPasswordReset } from "@/lib/auth/service";
import { apiRoute, jsonOk, readJsonBody } from "@/lib/http";

interface RequestBody {
  email?: string;
}

export const POST = apiRoute(async (request: NextRequest) => {
  const body = await readJsonBody<RequestBody>(request);
  const result = await requestPasswordReset(body.email ?? "");

  // Same response whether or not the address exists (SEC-03: no account
  // enumeration). The token is only ever included outside production,
  // where there is no email provider wired up yet (see lib/auth/service.ts).
  return jsonOk({
    message: "Si un compte existe avec cette adresse, un lien de réinitialisation a été envoyé.",
    ...(result ? { devToken: result.token, devExpiresAt: result.expiresAt.toISOString() } : {}),
  });
});
