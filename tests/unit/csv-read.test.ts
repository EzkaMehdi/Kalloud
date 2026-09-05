import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain JS module shared with the CLI scripts, same precedent as tests/unit/backup-retention.test.ts
import { detectDelimiter, readCsvRecords } from "../../scripts/lib/csv-read.mjs";

/**
 * OPS-09: the reader behind the pilot import.
 *
 * The cases below are what a real spreadsheet export actually contains, and
 * every one of them was a way to corrupt a customer's catalogue silently —
 * which is the only failure mode that matters here. An import that refuses a
 * file is annoying; an import that writes 2 € for a 2,50 € product is
 * discovered at the till, by a customer.
 */

describe("CSV reader (OPS-09)", () => {
  it("keeps a French decimal intact", () => {
    // The bug this was written for: treating `;` and `,` as separators at
    // the same time split "2,50" into two cells, and the product would have
    // been priced at 2 € without a word of complaint.
    const { records } = readCsvRecords('Nom;Prix\n"Café";2,50\n');
    expect(records[0].prix).toBe("2,50");
  });

  it("detects the separator from the header, where no decimal can appear", () => {
    expect(detectDelimiter("Nom;Prix;Stock\n")).toBe(";");
    expect(detectDelimiter("Nom,Prix,Stock\n")).toBe(",");
    // A comma inside a quoted header is not a separator.
    expect(detectDelimiter('"Nom, complet";Prix\n')).toBe(";");
  });

  it("keeps a comma that belongs to a product name", () => {
    const { records } = readCsvRecords('Nom;Prix\n"Café, allongé";2,50\n');
    expect(records[0].nom).toBe("Café, allongé");
  });

  it("unescapes doubled quotes", () => {
    const { records } = readCsvRecords('Nom;Prix\n"Sirop ""maison""";3,50\n');
    expect(records[0].nom).toBe('Sirop "maison"');
  });

  it("keeps a newline inside a quoted cell", () => {
    const { records } = readCsvRecords('Nom;Prix\n"Planche\nmixte";14,90\n');
    expect(records[0].nom).toBe("Planche\nmixte");
    expect(records).toHaveLength(1);
  });

  it("strips the byte-order mark Excel writes", () => {
    // Left in place it becomes part of the first header name, and every
    // lookup on that column silently returns nothing.
    const { records, headers } = readCsvRecords("﻿Nom;Prix\nCafé;2,50\n");
    expect(headers[0]).toBe("nom");
    expect(records[0].nom).toBe("Café");
  });

  it("matches headers whatever their case, accents or spacing", () => {
    const { records } = readCsvRecords("  NOM ;Prix; Catégorie \nCafé;2,50;Boissons\n");
    expect(records[0].nom).toBe("Café");
    expect(records[0].categorie).toBe("Boissons");
  });

  it("reports the file's own line numbers, so an operator can fix the file", () => {
    const { records } = readCsvRecords("Nom;Prix\nCafé;2,50\nThé;2,00\n");
    expect(records.map((record: { __line: number }) => record.__line)).toEqual([2, 3]);
  });

  it("ignores blank lines rather than importing empty products", () => {
    const { records } = readCsvRecords("Nom;Prix\nCafé;2,50\n\n;\nThé;2,00\n");
    expect(records).toHaveLength(2);
  });

  it("handles CRLF, which is what Windows writes", () => {
    const { records } = readCsvRecords("Nom;Prix\r\nCafé;2,50\r\n");
    expect(records[0].prix).toBe("2,50");
  });

  it("returns nothing for an empty file rather than throwing", () => {
    expect(readCsvRecords("").records).toEqual([]);
  });
});
