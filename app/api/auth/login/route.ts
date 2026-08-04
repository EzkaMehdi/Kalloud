import type { NextRequest } from "next/server";
import { login } from "@/lib/auth/service";
import { setSessionCookie } from "@/lib/auth/cookies";
import { apiRoute, getClientIp, jsonOk, readJsonBody } from "@/lib/http";

interface LoginBody {
  email?: string;
  password?: string;
}

export const POST = apiRoute(async (request: NextRequest) => {
  const body = await readJsonBody<LoginBody>(request);
  const result = await login({
    email: body.email ?? "",
    password: body.password ?? "",
    ipAddress: getClientIp(request),
    userAgent: request.headers.get("user-agent"),
  });

  const response = jsonOk({ ok: true });
  setSessionCookie(response, result.token, result.expiresAt);
  return response;
});
