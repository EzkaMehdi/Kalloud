import { describe, expect, it } from "vitest";
import { toCsv } from "../../lib/csv";

/** BI-12/DEC-09: the CSV export format, literally — BOM, `;`, CRLF, RFC 4180 quoting only when needed. */
describe("BI-12: toCsv", () => {
  it("starts with a UTF-8 BOM", () => {
    const csv = toCsv(["Colonne"], [["valeur"]]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
  });

  it("separates fields with ';', not ','", () => {
    const csv = toCsv(["A", "B"], [["1", "2"]]);
    expect(csv).toContain("A;B");
    expect(csv).toContain("1;2");
  });

  it("uses CRLF line endings", () => {
    const csv = toCsv(["A"], [["1"], ["2"]]);
    expect(csv).toContain("A\r\n1\r\n2\r\n");
  });

  it("quotes a field only when it actually contains the delimiter, a quote, or a newline", () => {
    const csv = toCsv(["Motif"], [["Rien à signaler"], ["Casse ; verre"], ['Dit "attention"']]);
    const lines = csv.slice(1).split("\r\n"); // slice(1) drops the BOM
    expect(lines[1]).toBe("Rien à signaler"); // no delimiter/quote: untouched
    expect(lines[2]).toBe('"Casse ; verre"');
    expect(lines[3]).toBe('"Dit ""attention"""'); // internal quotes doubled, RFC 4180
  });

  it("produces an empty-body file (header only) for zero rows, still BOM-prefixed", () => {
    const csv = toCsv(["Colonne"], []);
    expect(csv).toBe(`${String.fromCharCode(0xfeff)}Colonne\r\n`);
  });
});
