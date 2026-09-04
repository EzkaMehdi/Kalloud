import { expect, test, type Page } from "@playwright/test";
import { auditPage, MIN_TARGET_PX } from "./helpers/a11y";
import { openOwnTable } from "./helpers/floor";

/**
 * OPS-07: "audit clavier, lecteur d'écran, contrastes et viewports réels",
 * pour « aucun blocage WCAG A/AA connu sur les parcours MVP ».
 *
 * A recette is only worth having if it can be re-run, so the measurable
 * half is a test rather than a report: every screen of the MVP journey, at
 * the five widths UX-04 named, with the rendered contrast of every text
 * node computed against the colour actually painted behind it.
 *
 * That measurement is what this ticket produced. It found five hard-coded
 * greys that `UX-04` believed it had fixed — the token was darkened, but
 * these rules carried their own copies, so the fix never reached the
 * navigation labels, the period tabs, the KPI captions or the breakdown
 * lines. And it found `.split b` painting `--ink` on the dark green card:
 * **1,35:1**, the amounts in the cash breakdown effectively invisible.
 *
 * What this cannot do is replace a screen reader or a human eye. Those are
 * recorded in docs/accessibilite.md, not pretended away here.
 */

/**
 * UX-04 names these explicitly; 320 is the narrowest phone still in use.
 *
 * `full` marks the two that also get the contrast and naming audit. Colour
 * does not change with width — only the layout around it does, and this app
 * has two layouts, phone and the 700px-and-up sidebar. Auditing all five
 * repeated the same findings four times over and cost enough page loads to
 * make the dev server drop connections under the whole suite (`ECONNRESET`
 * in a neighbouring spec, roughly one run in three). Overflow, which *is*
 * width-dependent, still runs at every one.
 */
const VIEWPORTS = [
  { name: "320", width: 320, height: 640, full: false },
  { name: "375", width: 375, height: 812, full: true },
  { name: "700", width: 700, height: 1024, full: false },
  { name: "768", width: 768, height: 1024, full: false },
  { name: "1024", width: 1024, height: 768, full: true },
];

const SCREENS = ["/caisse", "/stock", "/bilan", "/configuration"];

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Adresse e-mail").fill("owner@kalloud.test");
  await page.getByLabel("Mot de passe").fill("Kalloud123!");
  await page.getByRole("button", { name: /se connecter/i }).click();
  await expect(page).toHaveURL(/\/caisse$/);
}

/**
 * WCAG 2.5.8 exempts a link inline in a sentence — "Pas encore de compte ?
 * Créer mon établissement" — and padding one to 44px would break the
 * sentence around it. Everything else on a till is a thumb target.
 */
async function oversizedTargetFailures(page: Page) {
  const report = await auditPage(page);
  return report.targets.filter(
    (target) =>
      !target.selector.startsWith("a") ||
      target.selector.includes("skip-link") ||
      target.selector.includes("nav-item"),
  );
}

async function expectNoFailures(page: Page, where: string, full: boolean) {
  const report = await auditPage(page);
  expect(report.horizontalOverflowPx, `${where} — débordement horizontal`).toBe(0);
  if (!full) return;
  expect(report.contrast, `${where} — texte sous le seuil WCAG AA`).toEqual([]);
  expect(report.unnamedControls, `${where} — contrôle sans nom accessible`).toEqual([]);
}

test.describe("OPS-07: WCAG A/AA on the MVP screens", () => {
  for (const viewport of VIEWPORTS) {
    test(`the public screens hold up at ${viewport.name}px`, async ({ page }) => {
      // Audited signed out, in their own test. An earlier version cleared
      // cookies inside the authenticated loop to reach them, which raced
      // the in-flight session request and made the whole file flaky —
      // roughly one run in six died on a login that never completed.
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      for (const path of ["/login", "/signup"]) {
        await page.goto(path);
        await page.waitForLoadState("networkidle");
        await expectNoFailures(page, `${path} @ ${viewport.name}px`, viewport.full);
      }
    });

    test(`the establishment's screens hold up at ${viewport.name}px`, async ({ page }) => {
      test.slow();
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page);

      for (const path of SCREENS) {
        await page.goto(path);
        await page.waitForLoadState("networkidle");
        await expectNoFailures(page, `${path} @ ${viewport.name}px`, viewport.full);
      }
    });
  }

  test("the busy states are audited too, not only the empty screen", async ({ page }) => {
    await signIn(page);

    // A floor plan with every table free is not the screen anyone works on.
    // The first pass of this audit ran on exactly that and missed
    // `.pill.busy` at 4,04:1 — the badge that tells a room which tables are
    // occupied. So the state is created rather than waited for.
    await openOwnTable(page);
    await page.keyboard.press("Escape");
    await page.goto("/caisse");
    await page.waitForLoadState("networkidle");

    const report = await auditPage(page);
    expect(report.contrast, "états occupés — texte sous le seuil WCAG AA").toEqual([]);
  });

  test(`every control a thumb must hit is at least ${MIN_TARGET_PX}px`, async ({ page }) => {
    test.slow();
    await page.setViewportSize({ width: 375, height: 812 });
    await signIn(page);

    for (const path of SCREENS) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      expect(await oversizedTargetFailures(page), `${path} — cible trop petite`).toEqual([]);
    }
  });
});

test.describe("OPS-07: the keyboard alone is enough", () => {
  test("a skip link jumps straight to the content, and it is the first stop", async ({ page }) => {
    await signIn(page);
    await page.goto("/caisse");

    // UX-03: the first Tab from the top of the document reaches it, and it
    // becomes visible when focused — a skip link nobody can see is one
    // nobody uses.
    await page.keyboard.press("Tab");
    const focused = page.locator(":focus");
    await expect(focused).toHaveClass(/skip-link/);
    await expect(focused).toBeVisible();

    await page.keyboard.press("Enter");
    await expect(page.locator("#main-content")).toBeFocused();
  });

  test("focus is always visible as it moves", async ({ page }) => {
    await signIn(page);
    await page.goto("/caisse");

    // An outline of 0 with no other ring is WCAG 2.4.7 failed: someone
    // navigating by keyboard would not know where they are.
    //
    // Two things are skipped, and neither is the product: `body`, which is
    // what `document.activeElement` reports while focus passes through the
    // browser's own chrome on the wrap-around, and `NEXTJS-PORTAL`, the dev
    // server's error-overlay host — it does not exist in a production
    // build. An earlier version of this test failed on both and would have
    // had me "fix" a defect that was not there.
    let checked = 0;
    for (let step = 0; step < 14; step += 1) {
      await page.keyboard.press("Tab");
      const ring = await page.evaluate(() => {
        const element = document.activeElement;
        if (!element || element === document.body) return null;
        if (element.tagName === "NEXTJS-PORTAL") return null;
        const style = getComputedStyle(element);
        return {
          tag: element.tagName,
          text: (element.textContent ?? "").trim().slice(0, 30),
          outlineWidth: style.outlineWidth,
          outlineStyle: style.outlineStyle,
          boxShadow: style.boxShadow,
        };
      });
      if (!ring) continue;
      checked += 1;
      const visible =
        (ring.outlineStyle !== "none" && parseFloat(ring.outlineWidth) > 0) ||
        (ring.boxShadow !== "none" && ring.boxShadow !== "");
      expect(
        visible,
        `étape ${step} (${ring.tag} « ${ring.text} ») : focalisé sans indicateur visible`,
      ).toBe(true);
    }
    expect(checked, "aucun contrôle réel atteint : le test ne prouve rien").toBeGreaterThan(4);
  });

  test("a dialog traps focus, closes on Escape, and gives focus back", async ({ page }) => {
    await signIn(page);
    await page.goto("/caisse");

    const opener = page.getByRole("button", { name: /^mouvement$/i });
    await opener.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // UX-02: focus moves into the dialog rather than staying behind it.
    const insideAtOpen = await page.evaluate(() =>
      Boolean(document.querySelector("dialog[open]")?.contains(document.activeElement)),
    );
    expect(insideAtOpen, "le focus doit entrer dans la boîte de dialogue").toBe(true);

    // Tabbing all the way round never reaches an interactive element behind
    // the dialog. Phrased that way rather than "activeElement is always
    // inside", because on the wrap-around the browser parks focus on its
    // own chrome for one step and `activeElement` reports `body` — which is
    // not an escape, and an earlier version of this test called it one.
    for (let step = 0; step < 15; step += 1) {
      await page.keyboard.press("Tab");
      const escaped = await page.evaluate(() => {
        const dialog = document.querySelector("dialog[open]");
        const element = document.activeElement;
        if (!dialog || !element || element === document.body) return null;
        if (element.tagName === "NEXTJS-PORTAL") return null;
        return dialog.contains(element)
          ? null
          : { tag: element.tagName, text: (element.textContent ?? "").trim().slice(0, 30) };
      });
      expect(
        escaped,
        `étape ${step} : le focus a atteint un contrôle derrière la boîte de dialogue`,
      ).toBeNull();
    }

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    // And it comes back where it was, so the keyboard user does not restart
    // from the top of the page.
    await expect(opener).toBeFocused();
  });

  test("a sale can be rung up without a mouse", async ({ page }) => {
    await signIn(page);
    await page.goto("/caisse");

    // The MVP's central journey, driven by keyboard alone: the acceptance
    // says "aucun blocage" on the MVP paths, and a till a keyboard cannot
    // operate is a blockage whatever the contrast reports say.
    const table = page.getByRole("button", { name: /Table 1/ });
    await table.focus();
    await page.keyboard.press("Enter");

    const drawer = page.getByRole("dialog");
    await expect(drawer).toBeVisible();
    const product = drawer.getByRole("button", { name: /Café/ }).first();
    await product.focus();
    await page.keyboard.press("Enter");
    await expect(drawer.locator(".ticket-line")).toContainText("Café");

    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
  });
});
