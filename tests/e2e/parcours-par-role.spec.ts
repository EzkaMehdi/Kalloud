import { expect, test, type Page } from "@playwright/test";
import { createThrowawayTenant, type ThrowawayTenant, type TenantMember } from "./helpers/tenant";

/**
 * OPS-06B: "tous les parcours P1 inclus au MVP passent **sur les trois
 * rôles**."
 *
 * The emphasis is the whole ticket. This suite has proven at length that
 * roles are *refused* what DEC-07 denies them — `tests/unit/authz.test.ts`
 * asserts the matrix line by line, and half a dozen specs check the 403.
 * What no test asked was the opposite question: can a cashier actually get
 * through a shift? Can a manager run the establishment? The suite was 21
 * owner sign-ins against two apiece for the other roles, and those two only
 * ever confirmed a door was locked.
 *
 * So each role here does a real day's work, in sequence, on one
 * establishment — which also exercises the handovers a real service has:
 * the cashier opens and sells, the manager corrects and refunds and reads
 * the cockpit, the owner configures, the cashier closes. Isolated per-role
 * runs would have missed exactly that.
 *
 * `describe.serial` because a business day is location-wide state, the same
 * reason tests/e2e/business-day-open-close.spec.ts declares its order.
 */
test.describe.serial("OPS-06B: the three roles each do their own day's work", () => {
  let tenant: ThrowawayTenant;
  let manager: TenantMember;
  let cashier: TenantMember;
  let productName: string;
  let productId: number;
  let tableName: string;

  test.beforeAll(async () => {
    tenant = await createThrowawayTenant("OPS-06B");
    manager = await tenant.addMember("MANAGER", "manager");
    cashier = await tenant.addMember("CASHIER", "cashier");
  });

  test.afterAll(() => tenant.dispose());

  /** The nav is filtered by permission, so it is the cheapest read of "what may this person do". */
  async function navigationLinks(page: Page): Promise<string[]> {
    return page.locator(".nav-item span").allTextContents();
  }

  test("the owner sets the establishment up — the only role that may", async ({ page }) => {
    await tenant.login(page);
    expect(await navigationLinks(page)).toEqual(["Caisse", "Stock", "Bilan", "Réglages"]);

    await page.goto("/configuration");

    // CFG-01, settings:manage — OWNER alone (DEC-07).
    const settingsCard = page
      .locator(".history-card")
      .filter({ has: page.getByLabel("Devise (code ISO, ex. EUR)") });
    await expect(settingsCard.getByLabel("Nom de l’établissement")).toBeEditable();

    tableName = `T-${Date.now().toString(36)}`;
    const tableForm = page
      .locator(".history-card")
      .filter({ has: page.getByLabel("Nouvelle table") });
    await tableForm.getByLabel("Nouvelle table").fill(tableName);
    await tableForm.getByRole("button", { name: /^créer$/i }).click();

    productName = `Test OPS-06B ${Date.now().toString(36)}`;
    await page.getByLabel("Nouveau produit").fill(productName);
    await page.getByLabel("Prix de vente (€)").fill("5.00");
    await page.getByLabel("Stock initial (facultatif)").fill("20");
    await page.getByRole("button", { name: /ajouter au catalogue/i }).click();
    // Waited for on screen before being read back through the API: clicking
    // only starts the request.
    await expect(page.locator(".order-row").filter({ hasText: productName })).toBeVisible();

    const products = await (await page.request.get("/api/products")).json();
    const created = products.find((product: { name: string }) => product.name === productName);
    expect(created, "the owner's catalogue entry must exist").toBeTruthy();
    productId = created.id;

    // The team screen, owner-only (SAAS-02).
    await expect(page.getByRole("heading", { name: "Équipe" })).toBeVisible();
  });

  test("the cashier opens the service and works a real ticket", async ({ page }) => {
    await cashier.login(page);

    // DEC-07 gives a cashier the till and the stock screen, and nothing
    // else: no cockpit, no settings. The interface says so before any
    // endpoint has to.
    expect(await navigationLinks(page)).toEqual(["Caisse", "Stock"]);

    await page.getByRole("button", { name: /ouvrir le service/i }).click();
    const openDialog = page.getByRole("dialog");
    await openDialog.getByLabel(/fond de caisse d'ouverture/i).fill("60.00");
    await openDialog.getByRole("button", { name: /^ouvrir le service$/i }).click();
    await expect(page.getByText("Service ouvert", { exact: true })).toBeVisible();

    // A ticket on a table, paid in cash.
    await page.getByRole("button", { name: new RegExp(escape(tableName)) }).click();
    const ticket = page.getByRole("dialog");
    await ticket.getByRole("button", { name: new RegExp(escape(productName)) }).click();
    await ticket.getByRole("button", { name: new RegExp(escape(productName)) }).click();
    await expect(ticket.locator(".ticket-total")).toContainText("10.00");
    await ticket.getByRole("radio", { name: "Espèces" }).click();
    await ticket.getByRole("button", { name: /encaisser/i }).click();
    await expect(ticket).toBeHidden();

    // A cash movement — CASHIER holds `cash_movement:create` (DEC-07).
    await page.getByRole("button", { name: /^mouvement$/i }).click();
    const movement = page.getByRole("dialog");
    await movement.getByRole("radio", { name: "Entrée" }).click();
    await movement.getByLabel(/catégorie/i).selectOption("FUND_TOPUP");
    await movement.getByLabel(/montant/i).fill("5");
    await movement.getByLabel(/motif/i).fill("Appoint");
    await movement.getByRole("button", { name: /valider l.entrée/i }).click();
    await expect(movement).toHaveCount(0);
  });

  test("the cashier is refused the manager's operations, at the endpoint and not only on screen", async ({
    page,
  }) => {
    await cashier.login(page);

    // Hiding a button is a convenience; the server is what protects
    // (DEC-07). Each of these is a P1 operation the cashier must not reach.
    const refusals = [
      ["dashboard", await page.request.get("/api/dashboard")],
      ["export", await page.request.get("/api/exports/sales")],
      [
        "stock adjustment",
        await page.request.post(`/api/products/${productId}/stock`, {
          data: { delta: 5, type: "RECEIPT", reason: "Tentative" },
        }),
      ],
      [
        "catalogue",
        await page.request.post("/api/products", {
          data: { categoryId: null, name: "Interdit", price: "1.00" },
        }),
      ],
    ] as const;
    for (const [what, response] of refusals) {
      expect(response.status(), `a cashier must not reach ${what}`).toBe(403);
    }

    // And the stock screen they *do* have is read-only for them: STK-04's
    // adjust action belongs to `stock:adjust` (OWNER/MANAGER).
    await page.goto("/stock");
    await expect(page.locator(".stock-row").filter({ hasText: productName })).toBeVisible();
    await expect(
      page
        .locator(".stock-row")
        .filter({ hasText: productName })
        .getByRole("button", { name: /ajuster/i }),
    ).toHaveCount(0);
  });

  test("the manager runs the establishment: stock, refund, drill-down and exports", async ({
    page,
  }) => {
    await manager.login(page);
    expect(await navigationLinks(page)).toEqual(["Caisse", "Stock", "Bilan", "Réglages"]);

    // Stock adjustment (STK-04, stock:adjust).
    await page.goto("/stock");
    const row = page.locator(".stock-row").filter({ hasText: productName });
    await row.getByRole("button", { name: /ajouter du stock pour/i }).click();
    const adjust = page.getByRole("dialog");
    await adjust.getByLabel("Type de mouvement").selectOption("RECEIPT");
    await adjust.getByLabel("Quantité").fill("6");
    await adjust.getByLabel("Motif").fill("Réception fournisseur");
    await adjust.getByRole("button", { name: /enregistrer le mouvement/i }).click();
    await expect(adjust).toHaveCount(0);
    // 20 initial − 2 sold + 6 received.
    await expect(row).toContainText("24");

    // Cockpit and drill-down (BI-02, dashboard:view).
    await page.goto("/bilan");
    const revenue = page.locator(".kpi", { hasText: "Chiffre d'affaires" });
    await expect(revenue.locator("strong")).toHaveText("10,00 €");
    await page.getByRole("tab", { name: /encaissées/i }).click();
    await expect(page.locator(".order-row").first()).toBeVisible();

    // Exports (BI-12, export:create) — the response, not just the link.
    // `period=service` is what the cockpit's own export link carries while
    // the "Aujourd'hui" tab is selected (BI-12/BI-14: the export follows the
    // filters exactly).
    const csv = await page.request.get("/api/exports/sales?period=service");
    expect(csv.status(), await csv.text()).toBe(200);
    expect(await csv.text()).toContain(productName);

    // Refund (ORD-10, orders:refund).
    const orders = await (await page.request.get("/api/orders?status=PAID")).json();
    const paid = (Array.isArray(orders) ? orders : orders.orders)[0];
    const refund = await page.request.post(`/api/orders/${paid.id}/refund`, {
      data: { reason: "Client mécontent" },
      headers: { "Idempotency-Key": crypto.randomUUID() },
    });
    // 201: a refund creates a REFUND payment line rather than rewriting the
    // original one — the sale keeps its amount for the whole of its life
    // (ORD-10/DEC-09).
    expect(refund.status(), await refund.text()).toBe(201);
    const refunded = await refund.json();
    expect(refunded.status).toBe("REFUNDED");
    expect(refunded.netTotal).toBe("0.00");
  });

  test("the manager is refused what belongs to the owner alone", async ({ page }) => {
    await manager.login(page);
    await page.goto("/configuration");

    // A manager administers the catalogue and the floor plan, so the screen
    // is theirs — but the establishment's own settings are read-only and the
    // team section is absent entirely (DEC-07).
    await expect(page.getByRole("heading", { name: "Plan de salle" })).toBeVisible();
    await expect(page.getByLabel("Devise (code ISO, ex. EUR)")).toBeDisabled();
    await expect(page.getByRole("heading", { name: "Équipe" })).toHaveCount(0);

    expect((await page.request.get("/api/team")).status()).toBe(403);
    expect(
      (
        await page.request.put("/api/settings", {
          data: {
            name: "Détourné",
            timezone: "Europe/Paris",
            currency: "EUR",
            defaultTaxRate: "20.00",
            cashDiscrepancyThreshold: "5.00",
          },
        })
      ).status(),
    ).toBe(403);
  });

  test("the cashier closes the service they opened", async ({ page }) => {
    await cashier.login(page);

    // DEC-07 gives `business_day:close` to all three roles: the person who
    // worked the shift is the one who counts the drawer.
    await page.getByRole("button", { name: /compter et clôturer la caisse/i }).click();
    const closing = page.getByRole("dialog");
    // The day three roles worked, reconciled: 60 € float, +10 € cash sale
    // (cashier), +5 € top-up (cashier), −10 € refunded in cash (manager).
    await expect(closing).toContainText("Fond de caisse d'ouverture");
    await expect(closing).toContainText("Espèces attendues");
    await expect(closing).toContainText("65,00 €");

    await closing.getByLabel(/espèces comptées/i).fill("65");
    await closing.getByRole("button", { name: /compter et clôturer la caisse/i }).click();
    await expect(closing).toBeHidden();
    await expect(page.getByText("Aucun service ouvert")).toBeVisible();
  });
});

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
