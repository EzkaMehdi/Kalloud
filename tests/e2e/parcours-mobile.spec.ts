import { Pool } from "pg";
import { expect, test } from "@playwright/test";

/**
 * `GATE-7` : « les parcours complets passent sur mobile, tablette et
 * desktop ».
 *
 * `OPS-07` mesure le contraste, le débordement et les cibles tactiles à cinq
 * largeurs, mais sur des écrans au repos ; `OPS-06` fait le parcours entier
 * mais à une seule largeur. Ni l'un ni l'autre ne répondait à la question de
 * cette porte : est-ce qu'on peut **tenir un service** sur un téléphone ?
 *
 * Un tiroir de commande qui déborde, un bouton d'encaissement poussé sous la
 * barre de navigation, une modale de clôture plus haute que l'écran — rien de
 * tout cela n'apparaît sur une page qu'on regarde sans y toucher. Il faut
 * cliquer.
 *
 * Le desktop est déjà couvert par `tests/e2e/parcours-complet.spec.ts`, qui
 * vérifie en plus les invariants en base ; ceux-là ne dépendent pas de la
 * largeur, donc ils ne sont pas rejoués ici.
 */

const VIEWPORTS = [
  { name: "mobile 375", width: 375, height: 812 },
  { name: "tablette 768", width: 768, height: 1024 },
];

const createdOrganizations: string[] = [];
const createdEmails: string[] = [];

test.afterAll(async () => {
  if (createdOrganizations.length === 0) return;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const { rows } = await pool.query<{ id: number }>(
      "SELECT id FROM organizations WHERE name = ANY($1)",
      [createdOrganizations],
    );
    for (const { id } of rows) {
      const { rows: locations } = await pool.query<{ id: number }>(
        "SELECT id FROM locations WHERE organization_id = $1",
        [id],
      );
      for (const location of locations) {
        // Enfants d'abord : l'historique de vente et de stock n'est pas
        // supprimable en cascade (cf. helpers/tenant.ts).
        await pool.query("DELETE FROM stock_counts WHERE location_id = $1", [location.id]);
        await pool.query("DELETE FROM stock_movements WHERE location_id = $1", [location.id]);
        await pool.query("DELETE FROM payments WHERE location_id = $1", [location.id]);
        await pool.query("DELETE FROM orders WHERE location_id = $1", [location.id]);
      }
      await pool.query("DELETE FROM organizations WHERE id = $1", [id]);
    }
    await pool.query("DELETE FROM login_attempts WHERE email = ANY($1)", [createdEmails]);
    await pool.query("DELETE FROM users WHERE email = ANY($1)", [createdEmails]);
  } finally {
    await pool.end();
  }
});

for (const viewport of VIEWPORTS) {
  test(`GATE-7 : une journée entière se tient à ${viewport.name}`, async ({ page }) => {
    test.slow();
    await page.setViewportSize({ width: viewport.width, height: viewport.height });

    const suffix = crypto.randomUUID().slice(0, 8);
    const establishment = `E2E GATE-7 ${suffix}`;
    const email = `gate7-${suffix}@example.test`;
    createdOrganizations.push(establishment);
    createdEmails.push(email);

    // Inscription
    await page.goto("/signup");
    await page.getByLabel("Nom de l'établissement").fill(establishment);
    await page.getByLabel("Votre nom").fill("Gérante Test");
    await page.getByLabel("Adresse e-mail").fill(email);
    await page.getByLabel("Mot de passe").fill("Password123!");
    await page.getByRole("button", { name: /^créer mon établissement$/i }).click();
    await expect(page).toHaveURL(/\/configuration$/);

    // Configuration
    const tableName = `T-${suffix}`;
    const productName = `Test GATE-7 ${suffix}`;
    const tableForm = page
      .locator(".history-card")
      .filter({ has: page.getByLabel("Nouvelle table") });
    await tableForm.getByLabel("Nouvelle table").fill(tableName);
    await tableForm.getByRole("button", { name: /^créer$/i }).click();

    await page.getByLabel("Nouveau produit").fill(productName);
    await page.getByLabel("Prix de vente (€)").fill("4.00");
    await page.getByLabel("Stock initial (facultatif)").fill("10");
    await page.getByRole("button", { name: /ajouter au catalogue/i }).click();
    await expect(page.getByText(/2 étape\(s\) sur 3/)).toBeVisible();

    // Ouverture du service
    await page.getByRole("link", { name: /y aller/i }).click();
    await expect(page).toHaveURL(/\/caisse$/);
    await page.getByRole("button", { name: /ouvrir le service/i }).click();
    const openDialog = page.getByRole("dialog");
    await openDialog.getByLabel(/fond de caisse d'ouverture/i).fill("50.00");
    await openDialog.getByRole("button", { name: /^ouvrir le service$/i }).click();
    await expect(page.getByText("Service ouvert", { exact: true })).toBeVisible();

    // Vente sur la table
    await page.getByRole("button", { name: new RegExp(tableName) }).click();
    const ticket = page.getByRole("dialog");
    const product = ticket.getByRole("button", { name: new RegExp(productName) });
    await product.click();
    await expect(ticket.locator(".ticket-line")).toContainText(productName);

    // Le bouton doit être **atteignable**, ce qui n'est pas la même chose
    // qu'« à l'écran sans rien faire » : sur un téléphone, une feuille de
    // caisse plus haute que l'écran défile, et faire défiler pour atteindre
    // le bouton est le geste normal. Une première version exigeait
    // `toBeInViewport()` avant le clic et échouait sur un comportement
    // parfaitement correct. Ce qui compte est que le clic aboutisse.
    const pay = ticket.getByRole("button", { name: /encaisser/i });
    await ticket.getByRole("radio", { name: "Espèces" }).click();
    await pay.click();
    await expect(ticket).toBeHidden();

    // Stock
    await page.goto("/stock");
    await expect(page.locator(".stock-row").filter({ hasText: productName })).toContainText("9");

    // Clôture
    await page.goto("/caisse");
    await page.getByRole("button", { name: /compter et clôturer la caisse/i }).click();
    const closing = page.getByRole("dialog");
    await expect(closing).toContainText("54,00 €");
    await closing.getByLabel(/espèces comptées/i).fill("54");
    const close = closing.getByRole("button", { name: /compter et clôturer la caisse/i });
    await close.click();
    await expect(closing).toBeHidden();
    await expect(page.getByText("Aucun service ouvert")).toBeVisible();
  });
}
