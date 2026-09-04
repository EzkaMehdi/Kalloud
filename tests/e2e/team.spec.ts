import { Pool } from "pg";
import { expect, test } from "@playwright/test";
import { createThrowawayTenant, type ThrowawayTenant } from "./helpers/tenant";

/**
 * SAAS-02's acceptance criterion: "seuls les rôles autorisés administrent
 * l'équipe ; actions auditées."
 *
 * The permission half belongs here rather than at the integration tier: the
 * guard is `requirePermission` inside the route, so the only way to prove a
 * manager is refused is to ask the real endpoint over HTTP with a manager's
 * cookie. The integration suite covers what the *service* refuses even to an
 * owner (last owner, self-suspension, another tenant's member).
 */

const PASSWORD = "Password123!";
const createdEmails: string[] = [];

let tenant: ThrowawayTenant;

test.beforeAll(async () => {
  tenant = await createThrowawayTenant("SAAS-02");
});

test.afterAll(async () => {
  await tenant.dispose();
  if (createdEmails.length === 0) return;
  // Deleting the organization cascades to the memberships, not to the
  // people: `users` is global (see tests/e2e/onboarding.spec.ts's own note).
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query("DELETE FROM login_attempts WHERE email = ANY($1)", [createdEmails]);
    await pool.query("DELETE FROM users WHERE email = ANY($1)", [createdEmails]);
  } finally {
    await pool.end();
  }
});

function newMemberEmail(label: string): string {
  const email = `saas02-${label}-${crypto.randomUUID().slice(0, 8)}@example.test`;
  createdEmails.push(email);
  return email;
}

test.describe("SAAS-02: the owner administers the team, and nobody else can", () => {
  test("adds a member, changes their role, then suspends them out of the product", async ({
    page,
  }) => {
    await tenant.login(page);
    await page.goto("/configuration");

    const email = newMemberEmail("member");
    // The role picker is addressed through its form rather than its label:
    // it sits inside a wrapping <label>, so its accessible name carries the
    // selected option along with the word "Rôle".
    const inviteForm = page.locator("form").filter({ hasText: "Ajouter au personnel" });
    await page.getByLabel("Nouveau membre").fill("Sarah Bernard");
    await page.getByLabel("Adresse e-mail").fill(email);
    await page.getByLabel("Mot de passe initial").fill(PASSWORD);
    await inviteForm.getByRole("combobox").selectOption("CASHIER");
    await page.getByRole("button", { name: /ajouter au personnel/i }).click();

    const row = page.locator(".order-row").filter({ hasText: "Sarah Bernard" });
    await expect(row).toContainText(email);
    await expect(row.getByRole("combobox")).toHaveValue("CASHIER");

    // The account works, with exactly the role it was given: a cashier has
    // no cockpit (DEC-07 `dashboard:view`).
    const memberContext = await page.context().browser()!.newContext();
    const memberPage = await memberContext.newPage();
    await memberPage.goto("/login");
    await memberPage.getByLabel("Adresse e-mail").fill(email);
    await memberPage.getByLabel("Mot de passe").fill(PASSWORD);
    await memberPage.getByRole("button", { name: /se connecter/i }).click();
    await expect(memberPage).toHaveURL(/\/caisse$/);
    expect((await memberPage.request.get("/api/dashboard")).status()).toBe(403);

    // Promotion. Asserted on the select's value, never on the row's text:
    // the row *contains* the role picker, so its text always holds all
    // three role names — an earlier version of this test asserted
    // `toContainText("Responsable")`, which passed before the request had
    // even been sent.
    await row.getByRole("combobox").selectOption("MANAGER");
    await expect(row.getByRole("combobox")).toHaveValue("MANAGER");
    expect((await memberPage.request.get("/api/dashboard")).status()).toBe(200);

    // Suspension takes the account away immediately — including the session
    // it already had open.
    await row.getByRole("button", { name: /désactiver/i }).click();
    await expect(row.locator("small")).toContainText("désactivé");
    expect((await memberPage.request.get("/api/dashboard")).status()).toBe(401);

    await memberPage.goto("/login");
    await memberPage.getByLabel("Adresse e-mail").fill(email);
    await memberPage.getByLabel("Mot de passe").fill(PASSWORD);
    await memberPage.getByRole("button", { name: /se connecter/i }).click();
    await expect(memberPage.locator("p.form-error")).toContainText(/identifiants invalides/i);

    // And it is reversible.
    await row.getByRole("button", { name: /réactiver/i }).click();
    await expect(row.locator("small")).not.toContainText("désactivé");
    await memberPage.getByRole("button", { name: /se connecter/i }).click();
    await expect(memberPage).toHaveURL(/\/caisse$/);

    await memberContext.close();
  });

  test("refuses the team to a manager, in the interface and at the endpoint", async ({ page }) => {
    await tenant.login(page);
    await page.goto("/configuration");

    const email = newMemberEmail("manager");
    const inviteForm = page.locator("form").filter({ hasText: "Ajouter au personnel" });
    await page.getByLabel("Nouveau membre").fill("Marc Dupuis");
    await page.getByLabel("Adresse e-mail").fill(email);
    await page.getByLabel("Mot de passe initial").fill(PASSWORD);
    await inviteForm.getByRole("combobox").selectOption("MANAGER");
    await page.getByRole("button", { name: /ajouter au personnel/i }).click();
    await expect(page.locator(".order-row").filter({ hasText: "Marc Dupuis" })).toBeVisible();

    const managerContext = await page.context().browser()!.newContext();
    const managerPage = await managerContext.newPage();
    await managerPage.goto("/login");
    await managerPage.getByLabel("Adresse e-mail").fill(email);
    await managerPage.getByLabel("Mot de passe").fill(PASSWORD);
    await managerPage.getByRole("button", { name: /se connecter/i }).click();
    await expect(managerPage).toHaveURL(/\/caisse$/);

    // The section is hidden — a convenience — and the endpoint refuses,
    // which is what actually protects it (DEC-07).
    await managerPage.goto("/configuration");
    await expect(managerPage.getByRole("heading", { name: "Plan de salle" })).toBeVisible();
    await expect(managerPage.getByRole("heading", { name: "Équipe" })).toHaveCount(0);

    expect((await managerPage.request.get("/api/team")).status()).toBe(403);
    const patched = await managerPage.request.patch(`/api/team/${tenant.ownerUserId}`, {
      data: { role: "CASHIER" },
    });
    expect(patched.status()).toBe(403);

    await managerContext.close();
  });

  test("says so, in view, when the e-mail is already taken", async ({ page }) => {
    await tenant.login(page);
    await page.goto("/configuration");

    const inviteForm = page.locator("form").filter({ hasText: "Ajouter au personnel" });
    await page.getByLabel("Nouveau membre").fill("Doublon");
    await page.getByLabel("Adresse e-mail").fill(tenant.email);
    await page.getByLabel("Mot de passe initial").fill(PASSWORD);
    await inviteForm.getByRole("combobox").selectOption("CASHIER");
    await page.getByRole("button", { name: /ajouter au personnel/i }).click();

    const alert = page.locator("p.form-error");
    await expect(alert).toContainText(/existe déjà/i);
    await expect(alert).toBeInViewport();
  });

  test("refuses to leave the establishment without an owner", async ({ page }) => {
    await tenant.login(page);
    await page.goto("/configuration");

    // Scrolled deep into the page first, which is the situation the banner
    // failed in: acting from the middle of a very long screen.
    await page.getByRole("heading", { name: "Plan de salle" }).scrollIntoViewIfNeeded();
    const ownerRow = page.locator(".order-row").filter({ hasText: tenant.email });
    await ownerRow.getByRole("combobox").selectOption("MANAGER");

    const alert = page.locator("p.form-error");
    await expect(alert).toContainText(/au moins un propriétaire actif/i);
    // `toBeVisible` is not enough, and that is exactly how this shipped
    // broken: the banner *was* rendered, a thousand pixels above the
    // viewport, so the refusal looked like a button doing nothing. What has
    // to hold is that the reader can see it from where they acted.
    await expect(alert).toBeInViewport();
    await expect(ownerRow.getByRole("combobox")).toHaveValue("OWNER");

    // Still an owner after a reload: the refusal is the server's, not a
    // client-side revert.
    await page.reload();
    await expect(page.locator(".order-row").filter({ hasText: tenant.email })).toContainText(
      "Propriétaire",
    );
  });
});
