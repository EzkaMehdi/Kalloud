import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function listFilesRecursively(dir: string): string[] {
  let results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      results = results.concat(listFilesRecursively(fullPath));
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      results.push(fullPath);
    }
  }
  return results;
}

const apiDir = join(process.cwd(), "app", "api");
const apiFiles = listFilesRecursively(apiDir);

// Health checks (infra probes, no tenant concept) and the auth endpoints
// that establish or clear a session in the first place are legitimately
// exempt from "must resolve a tenant" — that's the whole point of them.
const EXEMPT_FROM_CONTEXT_CHECK = [join(apiDir, "health"), join(apiDir, "auth")];
const businessApiFiles = apiFiles.filter(
  (file) => !EXEMPT_FROM_CONTEXT_CHECK.some((prefix) => file.startsWith(prefix)),
);

/**
 * SEC-06's acceptance criterion asks for "tests ou contrôle statique
 * détectent un accès non scopé". Repository/service functions already make
 * locationId a required, explicit TypeScript parameter (a compile error
 * catches an omitted scope), and SEC-08's integration tests prove scoping
 * holds at runtime across two real tenants. This static check adds the
 * third, complementary guarantee: no route handler can grow an inline SQL
 * query that bypasses the scoped repositories entirely, today or later.
 */
describe("SEC-06: route handlers never query the database directly", () => {
  it("finds route handler files to check (fails loudly if the API directory ever moves)", () => {
    expect(apiFiles.length).toBeGreaterThan(0);
  });

  it.each(apiFiles)("%s has no direct .query(...) call", (file) => {
    const content = readFileSync(file, "utf8");
    const callsQueryDirectly = /\.query\s*(<[^>]*>)?\s*\(/.test(content);
    expect(
      callsQueryDirectly,
      `${file} calls .query() directly. Route handlers must delegate to lib/repositories or lib/services instead.`,
    ).toBe(false);
  });

  it.each(businessApiFiles)(
    "%s resolves its tenant via requireRequestContext()/getRequestContext(), not client input",
    (file) => {
      const content = readFileSync(file, "utf8");
      const usesContext = /requireRequestContext\(\)|getRequestContext\(\)/.test(content);
      expect(
        usesContext,
        `${file} does not call requireRequestContext()/getRequestContext(); every business route must resolve locationId server-side.`,
      ).toBe(true);
    },
  );
});

/**
 * API-01's acceptance criterion is that *any* invalid input is rejected
 * before the database is reached. Per-endpoint tests can only prove that for
 * the endpoints that exist today; this check is what keeps it true for the
 * ones phase 3+ will add. `readJsonBody` returns an unchecked value by
 * design (it only guards size and JSON syntax) — reaching for it directly in
 * a route handler is exactly how unvalidated input used to reach a query,
 * so the only sanctioned entry point is parseJsonBody(request, schema).
 */
describe("API-01: route handlers validate every request body against a schema", () => {
  const bodyReadingFiles = apiFiles.filter((file) =>
    /readJsonBody|parseJsonBody/.test(readFileSync(file, "utf8")),
  );

  it("finds route handlers that read a request body", () => {
    expect(bodyReadingFiles.length).toBeGreaterThan(0);
  });

  it.each(bodyReadingFiles)("%s parses its body with parseJsonBody, not readJsonBody", (file) => {
    const content = readFileSync(file, "utf8");
    expect(
      /\breadJsonBody\s*[(<]/.test(content),
      `${file} calls readJsonBody() directly. Use parseJsonBody(request, schema) from lib/validation/parse.ts so the payload is validated before any database access.`,
    ).toBe(false);
  });
});

/**
 * OPS-08's injection axis, kept closed by a static check rather than by a
 * one-off review.
 *
 * Every filter value in this codebase reaches SQL as a bound parameter —
 * the `where` builders push onto `values` and emit `$n` — so the audit
 * found no injection path. What it cannot do is stay true on its own: the
 * next `${filters.something}` dropped into a query template would be one,
 * and it would read exactly like the safe interpolations around it.
 *
 * So the interpolations that exist are enumerated. A new one fails this
 * test, which is the point: it forces a deliberate look rather than a
 * silent addition. Everything listed is either a module-level SQL constant
 * or a placeholder index computed from the parameter array — never a value
 * that came from a request.
 */
const REVIEWED_SQL_INTERPOLATIONS = new Set([
  // Composed clause fragments; every value they reference is a $n bound parameter.
  "where",
  "limitClause",
  // Placeholder indices, not data.
  "values.length + 1",
  "values.length + 2",
  // Module-level SQL constants.
  "NET_PER_ORDER",
  "TABLE_WITH_OPEN_ORDER",
  "TAX_RESOLUTION_JOIN",
  "TICKET_SELECT",
]);

describe("OPS-08: no request value is ever interpolated into SQL", () => {
  const productionFiles = [
    ...listFilesRecursively(join(process.cwd(), "lib")),
    ...listFilesRecursively(join(process.cwd(), "app")),
  ];

  it("finds production files to check", () => {
    expect(productionFiles.length).toBeGreaterThan(0);
  });

  it("interpolates only reviewed, non-request expressions", () => {
    const unexpected: string[] = [];
    for (const file of productionFiles) {
      const content = readFileSync(file, "utf8");
      // No `s` flag: `[^`]` already matches newlines, and the flag needs a newer target.
      for (const call of content.matchAll(/\.query[^(]*\(\s*`([^`]*)`/g)) {
        for (const interpolation of call[1].matchAll(/\$\{([^}]+)\}/g)) {
          const expression = interpolation[1].trim();
          if (!REVIEWED_SQL_INTERPOLATIONS.has(expression)) {
            unexpected.push(`${file.replace(process.cwd() + "/", "")}: \${${expression}}`);
          }
        }
      }
    }
    expect(
      unexpected,
      "Nouvelle interpolation SQL. Si l'expression ne peut pas porter une valeur de requête, ajoutez-la à REVIEWED_SQL_INTERPOLATIONS ; sinon, passez par un paramètre lié $n.",
    ).toEqual([]);
  });
});
