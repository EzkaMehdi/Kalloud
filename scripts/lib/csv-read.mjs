/**
 * OPS-09: a minimal RFC 4180 reader for the pilot import.
 *
 * Hand-written rather than pulled in as a dependency, for the same reason
 * `lib/csv.ts` writes its own: the format a spreadsheet exports is small and
 * completely specified, and the failure this import must avoid — a quoted
 * product name containing a comma or a newline silently splitting into two
 * columns — is exactly what a naive `split(",")` does and what a real parser
 * costs three dozen lines to prevent.
 */

/**
 * Which character separates the columns.
 *
 * Detected from the header line rather than accepted as "either", which is
 * the mistake this function exists to avoid: treating `;` and `,` as
 * separators at the same time turns a French price of `2,50` into two cells,
 * and the import would have written 2 € for a 2,50 € product without a word
 * of complaint. A file has exactly one separator, and the header line — the
 * one row guaranteed to contain no decimals — is where to read it.
 */
export function detectDelimiter(text) {
  const header = text.replace(/^\ufeff/, "").split(/\r?\n/)[0] ?? "";
  let semicolons = 0;
  let commas = 0;
  let quoted = false;
  for (let index = 0; index < header.length; index += 1) {
    const char = header[index];
    if (char === '"') quoted = !quoted;
    else if (!quoted && char === ";") semicolons += 1;
    else if (!quoted && char === ",") commas += 1;
  }
  // Ties go to the semicolon: a French spreadsheet's default, and the one
  // that cannot be confused with a decimal separator.
  return semicolons >= commas && semicolons > 0 ? ";" : ",";
}

/** Splits CSV text into rows of raw string cells, honouring quotes and embedded newlines. */
export function parseCsv(text, delimiter = detectDelimiter(text)) {
  // A BOM is what Excel writes; left in place it becomes part of the first
  // header name and every lookup on that column fails with no explanation.
  const input = text.replace(/^\ufeff/, "");
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];

    if (quoted) {
      if (char === '"') {
        if (input[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") {
      cell += char;
    }
  }

  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return rows.filter((entry) => entry.some((value) => value.trim() !== ""));
}

/**
 * Reads a CSV into objects keyed by its header row.
 *
 * Header names are compared without case, accents or surrounding spaces: a
 * file exported from a spreadsheet says "Prix" or "prix " or "PRIX", and
 * refusing it over that would send the operator back to edit a file that was
 * already correct.
 */
export function readCsvRecords(text) {
  const rows = parseCsv(text);
  if (rows.length === 0) return { headers: [], records: [] };

  const headers = rows[0].map(normalizeHeader);
  const records = rows.slice(1).map((row, index) => {
    const record = { __line: index + 2 };
    headers.forEach((header, column) => {
      record[header] = (row[column] ?? "").trim();
    });
    return record;
  });
  return { headers, records };
}

export function normalizeHeader(value) {
  return value.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}
