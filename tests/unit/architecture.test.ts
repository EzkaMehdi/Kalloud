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
