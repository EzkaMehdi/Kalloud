import { describe, expect, it } from "vitest";
import { formatZonedIso } from "../../lib/time";

/**
 * BI-12: `DEC-09`'s own worked example, verbatim — "2026-08-04T19:30:00+02:00"
 * — is the summer-DST case below, checked against the literal string the
 * decision names.
 */
describe("BI-12: formatZonedIso", () => {
  it("renders DEC-09's own example: Paris in summer (+02:00, DST)", () => {
    const instant = new Date("2026-08-04T17:30:00Z");
    expect(formatZonedIso(instant, "Europe/Paris")).toBe("2026-08-04T19:30:00+02:00");
  });

  it("renders Paris in winter (+01:00, no DST)", () => {
    const instant = new Date("2026-01-15T10:00:00Z");
    expect(formatZonedIso(instant, "Europe/Paris")).toBe("2026-01-15T11:00:00+01:00");
  });

  it("renders a zero offset explicitly as +00:00, not Z", () => {
    const instant = new Date("2026-03-01T08:00:00Z");
    expect(formatZonedIso(instant, "UTC")).toBe("2026-03-01T08:00:00+00:00");
  });

  it("renders a negative offset with the minus sign", () => {
    // Mid-January: New York is on standard time, UTC−05:00, no DST ambiguity.
    const instant = new Date("2026-01-15T10:00:00Z");
    expect(formatZonedIso(instant, "America/New_York")).toBe("2026-01-15T05:00:00-05:00");
  });

  it("keeps midnight as 00:00, not the ICU 24:00 rendering", () => {
    const instant = new Date("2026-06-01T00:00:00Z"); // exactly midnight UTC
    expect(formatZonedIso(instant, "UTC")).toBe("2026-06-01T00:00:00+00:00");
  });
});
