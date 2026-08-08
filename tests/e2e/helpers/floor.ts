import { expect, type Page } from "@playwright/test";

/**
 * Creates a dining table this test alone knows about, then opens its ticket.
 *
 * Every sale spec used to click the seeded "Table 1". That was safe while a
 * drawer was a purely local basket, but ORD-02 made a table's ticket
 * persistent and shared: with `fullyParallel`, two specs clicking Table 1
 * now land on the *same* open ticket, save over each other, and one gets the
 * 409 that ORD-05 is supposed to reserve for genuine multi-device conflicts.
 *
 * The fix is the one these files already apply to products — an isolated
 * fixture rather than a shared seeded row — extended to the floor plan.
 */
export async function openOwnTable(page: Page): Promise<string> {
  const name = `Test table ${crypto.randomUUID().slice(0, 8)}`;
  const created = await page.request.post("/api/tables", { data: { name } });
  expect(created.ok(), "creating the test's own isolated table must succeed").toBeTruthy();

  // The floor plan was rendered before this table existed.
  await page.reload();
  await page.getByRole("button", { name: new RegExp(escapeRegExp(name)) }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  return name;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
