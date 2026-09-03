import type { NextRequest } from "next/server";
import { setSessionCookie } from "@/lib/auth/cookies";
import { apiRoute, getClientIp, jsonOk } from "@/lib/http";
import { createEstablishment } from "@/lib/services/onboarding";
import { parseJsonBody } from "@/lib/validation/parse";
import { signupSchema } from "@/lib/validation/schemas";

/**
 * SAAS-01: the only unauthenticated *write* in the application, and the one
 * DEC-01 requires ("créer son compte et son établissement").
 *
 * Deliberately under `/api/auth/`: proxy.ts rate-limits that whole prefix
 * per IP (SEC-07), so the endpoint that can create rows without a session
 * inherits the same ceiling as the one that can guess passwords, rather than
 * needing a second, parallel rule that could be forgotten.
 *
 * It signs the new owner in on success. The alternative — redirect to the
 * login form — would ask someone to retype the password they chose ten
 * seconds earlier, for no security gain: the request that proves they own
 * the account is the one that just created it.
 */
export const POST = apiRoute(async (request: NextRequest) => {
  const body = await parseJsonBody(request, signupSchema);

  const result = await createEstablishment({
    establishmentName: body.establishmentName,
    ownerName: body.ownerName,
    email: body.email,
    password: body.password,
    ipAddress: getClientIp(request),
    userAgent: request.headers.get("user-agent"),
  });

  const response = jsonOk(
    { organizationId: result.organizationId, locationId: result.locationId },
    { status: 201 },
  );
  setSessionCookie(response, result.token, result.expiresAt);
  return response;
});
