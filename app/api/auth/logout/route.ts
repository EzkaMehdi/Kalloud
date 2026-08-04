import { clearSessionCookie, readSessionToken } from "@/lib/auth/cookies";
import { logout } from "@/lib/auth/service";
import { apiRoute, jsonOk } from "@/lib/http";

export const POST = apiRoute(async () => {
  const token = await readSessionToken();
  if (token) {
    await logout(token);
  }
  const response = jsonOk({ ok: true });
  clearSessionCookie(response);
  return response;
});
