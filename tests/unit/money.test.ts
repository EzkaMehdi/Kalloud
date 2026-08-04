import { describe, expect, it } from "vitest";
import {
  applyPercentCents,
  extractTaxCents,
  formatMoney,
  fromCents,
  InvalidMoneyAmountError,
  sumCents,
  toCents,
} from "../../lib/money";

describe("money helpers (DEC-05)", () => {
  it("converts decimal strings coming from Postgres into integer cents", () => {
    expect(toCents("12.50")).toBe(1250);
    expect(toCents("0.00")).toBe(0);
    expect(toCents(9.9)).toBe(990);
  });

  it("rejects non-finite amounts instead of silently producing NaN", () => {
    expect(() => toCents("not-a-number")).toThrow(InvalidMoneyAmountError);
    expect(() => fromCents(12.5)).toThrow(InvalidMoneyAmountError);
  });

  it("round-trips cents back to a DECIMAL(10,2)-compatible string", () => {
    expect(fromCents(1250)).toBe("12.50");
    expect(fromCents(0)).toBe("0.00");
    expect(fromCents(5)).toBe("0.05");
  });

  it("sums cent amounts without floating-point drift", () => {
    // 0.1 + 0.2 famously != 0.3 in IEEE754; cents arithmetic must not inherit that.
    expect(sumCents([toCents("0.10"), toCents("0.20")])).toBe(30);
    expect(sumCents([333, 333, 333])).toBe(999);
  });

  it("extracts VAT from a TTC total using the half-up rule", () => {
    // 100.00 TTC at 20% => HT = 83.333..., tax = 16.666... => rounds to 16.67
    expect(extractTaxCents(10000, 20)).toBe(1667);
    // 9.99 TTC at 10% => HT = 9.0818..., tax = 0.9081... => rounds to 0.91
    expect(extractTaxCents(999, 10)).toBe(91);
    // 0% tax class always yields no tax.
    expect(extractTaxCents(5000, 0)).toBe(0);
  });

  it("applies a percentage (e.g. a discount) half-up", () => {
    expect(applyPercentCents(1000, 10)).toBe(100);
    expect(applyPercentCents(999, 15)).toBe(150);
  });

  it("formats cents as a localized currency string", () => {
    expect(formatMoney(1250, "EUR", "fr-FR")).toContain("12,50");
  });
});
