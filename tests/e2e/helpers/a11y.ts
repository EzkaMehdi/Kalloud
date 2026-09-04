import type { Page } from "@playwright/test";

/**
 * OPS-07: the measurable half of an accessibility audit, run in the page.
 *
 * Written by hand rather than pulled from a library: the two things this
 * has to check on this product — that the *rendered* contrast of real text
 * meets WCAG 1.4.3, and that a till's controls are big enough for a thumb
 * mid-service — are both cheap to compute exactly, and a dependency that
 * reports a hundred generic findings would bury them. Everything here is
 * pure DOM measurement against the published thresholds.
 */

export interface ContrastFinding {
  text: string;
  selector: string;
  ratio: number;
  required: number;
  color: string;
  background: string;
}

export interface TargetFinding {
  name: string;
  selector: string;
  width: number;
  height: number;
}

export interface AuditReport {
  contrast: ContrastFinding[];
  targets: TargetFinding[];
  unnamedControls: { selector: string; html: string }[];
  horizontalOverflowPx: number;
}

/** WCAG 2.2 target size (2.5.8, AA) is 24×24; a till used standing needs more, so 44 is the bar here. */
export const MIN_TARGET_PX = 44;

export async function auditPage(page: Page): Promise<AuditReport> {
  return page.evaluate(() => {
    function parseColor(value: string): [number, number, number, number] | null {
      const match = value.match(/rgba?\(([^)]+)\)/);
      if (!match) return null;
      const parts = match[1]
        .split(/[\s,/]+/)
        .filter(Boolean)
        .map(Number);
      return [parts[0], parts[1], parts[2], parts[3] ?? 1];
    }

    function channel(value: number): number {
      const c = value / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }

    function luminance([r, g, b]: [number, number, number, number]): number {
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    }

    function contrast(
      foreground: [number, number, number, number],
      background: [number, number, number, number],
    ): number {
      const a = luminance(foreground);
      const b = luminance(background);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    }

    /**
     * The colour actually painted behind an element: walk up until an
     * ancestor has a non-transparent background. Computing contrast against
     * `transparent` is how an audit reports a perfect score on unreadable
     * text.
     */
    function effectiveBackground(element: Element): [number, number, number, number] {
      let node: Element | null = element;
      while (node) {
        const parsed = parseColor(getComputedStyle(node).backgroundColor);
        if (parsed && parsed[3] > 0) return parsed;
        node = node.parentElement;
      }
      return [255, 255, 255, 1];
    }

    function describe(element: Element): string {
      const tag = element.tagName.toLowerCase();
      const classes =
        typeof element.className === "string" && element.className.trim()
          ? `.${element.className.trim().split(/\s+/).slice(0, 2).join(".")}`
          : "";
      return `${tag}${classes}`;
    }

    function visible(element: Element): boolean {
      const style = getComputedStyle(element);
      if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") {
        return false;
      }
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    }

    const contrastFindings: ContrastFinding[] = [];
    const seen = new Set<string>();

    for (const element of Array.from(document.querySelectorAll("*"))) {
      if (!visible(element)) continue;
      if (element.closest("[aria-hidden='true']")) continue;

      // Only elements that paint text of their own, so a wrapper is not
      // blamed for its child's colour.
      const ownText = Array.from(element.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent?.trim() ?? "")
        .join(" ")
        .trim();
      if (!ownText) continue;

      const style = getComputedStyle(element);
      const foreground = parseColor(style.color);
      if (!foreground) continue;
      const background = effectiveBackground(element);

      const sizePx = parseFloat(style.fontSize);
      const weight = Number(style.fontWeight) || 400;
      // WCAG "large text": >=24px, or >=18.66px when bold.
      const isLarge = sizePx >= 24 || (sizePx >= 18.66 && weight >= 700);
      const required = isLarge ? 3 : 4.5;

      const ratio = contrast(foreground, background);
      if (ratio + 0.005 < required) {
        const key = `${describe(element)}|${style.color}|${ownText.slice(0, 30)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        contrastFindings.push({
          text: ownText.slice(0, 60),
          selector: describe(element),
          ratio: Math.round(ratio * 100) / 100,
          required,
          color: style.color,
          background: `rgb(${background[0]}, ${background[1]}, ${background[2]})`,
        });
      }
    }

    const targetFindings: TargetFinding[] = [];
    const unnamedControls: { selector: string; html: string }[] = [];
    const controls = document.querySelectorAll(
      "button, a[href], input, select, textarea, [role='button'], [role='radio'], [role='tab']",
    );

    for (const control of Array.from(controls)) {
      if (!visible(control)) continue;
      if (control.closest("[aria-hidden='true']")) continue;

      const box = control.getBoundingClientRect();
      if (box.width < 44 || box.height < 44) {
        targetFindings.push({
          name: (control.getAttribute("aria-label") ?? control.textContent ?? "")
            .trim()
            .slice(0, 40),
          selector: describe(control),
          width: Math.round(box.width),
          height: Math.round(box.height),
        });
      }

      // An accessible name, from any of the places one can come from.
      const name =
        control.getAttribute("aria-label") ??
        (control.getAttribute("aria-labelledby")
          ? document.getElementById(control.getAttribute("aria-labelledby")!)?.textContent
          : null) ??
        (control.id ? document.querySelector(`label[for="${control.id}"]`)?.textContent : null) ??
        control.closest("label")?.textContent ??
        control.getAttribute("title") ??
        control.textContent;
      if (!name || !name.trim()) {
        unnamedControls.push({
          selector: describe(control),
          html: control.outerHTML.slice(0, 120),
        });
      }
    }

    return {
      contrast: contrastFindings,
      targets: targetFindings,
      unnamedControls,
      horizontalOverflowPx: Math.max(
        0,
        document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    };
  }) as Promise<AuditReport>;
}
