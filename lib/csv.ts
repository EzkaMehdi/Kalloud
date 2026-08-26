/**
 * `DEC-09`'s CSV export format, literally: UTF-8 with a BOM (Excel FR/
 * Windows opens a BOM-less UTF-8 file as if it were the system codepage,
 * mangling every accented character on first open), `;` as the separator
 * (the francophone spreadsheet convention — Excel FR treats `,` as the
 * decimal separator, not a field separator), and `\r\n` line endings (the
 * same Windows/Excel compatibility reasoning as the BOM).
 *
 * Amounts and dates are NOT this module's concern: `DEC-09` requires raw
 * decimal amounts (`12.50`, never `12,50 €`) and ISO 8601 dates with an
 * explicit offset — both already the shape the database and
 * `lib/time.ts::formatZonedIso` produce, so every caller passes them
 * through as plain strings rather than this module reformatting them a
 * second time.
 */

// `String.fromCharCode` rather than a literal U+FEFF character in source:
// the character itself is invisible in an editor, which invites exactly
// the silent corruption this constant exists to prevent.
const BOM = String.fromCharCode(0xfeff);
const DELIMITER = ";";

/** RFC 4180 quoting: only when the field actually needs it, never unconditionally. */
function escapeField(value: string): string {
  if (
    value.includes(DELIMITER) ||
    value.includes('"') ||
    value.includes("\n") ||
    value.includes("\r")
  ) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** One `;`-delimited, BOM-prefixed CSV file: a French header row, then one row per record. */
export function toCsv(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const lines = [headers, ...rows].map((row) => row.map(escapeField).join(DELIMITER));
  return BOM + lines.join("\r\n") + "\r\n";
}
