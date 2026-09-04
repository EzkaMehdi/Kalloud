import { expect, test } from "@playwright/test";
import { createThrowawayTenant, type ThrowawayTenant, type TenantMember } from "./helpers/tenant";

/**
 * OPS-08: the findings of the final security review, kept closed.
 *
 * The review walked six axes — authentication, authorisation, tenant
 * isolation, injection, error exposure and dependencies — and most of them
 * already held: session tokens are random and stored hashed, expire and
 * revoke; every filter value reaches SQL as a bound parameter; unexpected
 * errors never forward their message to a client; `pnpm audit` is clean.
 *
 * Two authorisation holes were real, and both were reads. A permission
 * matrix is easy to apply to writes — they are obviously dangerous — and
 * easy to forget on a `GET` that "just displays something". These tests
 * exist so they cannot be forgotten again.
 */
test.describe.serial("OPS-08: the review's findings stay closed", () => {
  let tenant: ThrowawayTenant;
  let cashier: TenantMember;

  test.beforeAll(async () => {
    tenant = await createThrowawayTenant("OPS-08");
    cashier = await tenant.addMember("CASHIER", "caissier");
  });

  test.afterAll(() => tenant.dispose());

  test("a cashier cannot read the establishment's order history", async ({ page }) => {
    await cashier.login(page);

    // DEC-07: a cashier sees their own service, "mais pas l'historique
    // complet ni les KPI de gestion". The Bilan screen is hidden from them
    // and /api/dashboard refuses them — this endpoint was the door left
    // open to the same data, returning paid orders with their amounts and
    // the name of whoever took each sale, filterable by date.
    expect((await page.request.get("/api/orders?limit=50")).status()).toBe(403);
    expect((await page.request.get("/api/dashboard")).status()).toBe(403);
    expect((await page.request.get("/api/sales")).status()).toBe(403);
    expect((await page.request.get("/api/payments")).status()).toBe(403);
  });

  test("a cashier cannot read the establishment's settings", async ({ page }) => {
    await cashier.login(page);

    // `cashDiscrepancyThreshold` is the amount below which a till gap needs
    // no written justification (CASH-05) — precisely the number someone
    // shaving the drawer would want to know.
    const response = await page.request.get("/api/settings");
    expect(response.status()).toBe(403);
    expect(await response.text()).not.toContain("cashDiscrepancyThreshold");
  });

  test("the till a cashier does need still works", async ({ page }) => {
    await cashier.login(page);

    // The other half of the finding: closing a door must not close the
    // ones DEC-07 deliberately leaves open, or the fix breaks the shift.
    for (const path of ["/api/products", "/api/tables", "/api/tickets", "/api/cash-summary"]) {
      expect((await page.request.get(path)).status(), `${path} doit rester ouvert`).toBe(200);
    }
  });

  test("an owner still reads everything that is theirs", async ({ page }) => {
    await tenant.login(page);
    for (const path of ["/api/orders?limit=5", "/api/settings", "/api/dashboard"]) {
      expect((await page.request.get(path)).status(), `${path} pour un propriétaire`).toBe(200);
    }
  });

  test("an error never carries an internal detail to the client", async ({ page }) => {
    await tenant.login(page);

    // P0-09: a thrown internal error is logged in full server-side, keyed by
    // requestId, and answered with a generic message. Asserted on a real
    // refusal rather than on a contrived one.
    const response = await page.request.get("/api/orders?limit=notanumber");
    const body = await response.text();
    expect(response.status()).toBeGreaterThanOrEqual(400);
    for (const leak of ["/Users/", "node_modules", "SELECT", "pg_", "at Object."]) {
      expect(body, `la réponse expose « ${leak} »`).not.toContain(leak);
    }
    expect(JSON.parse(body).error.requestId, "un requestId doit permettre le suivi").toBeTruthy();
  });
});
