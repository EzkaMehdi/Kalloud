import { describe, expect, it } from "vitest";
import {
  checkProductionEnv,
  MIN_SECRET_LENGTH,
  // @ts-expect-error -- plain JS module shared with the CLI scripts, same precedent as tests/unit/backup-retention.test.ts
} from "../../scripts/lib/env-check.mjs";

/**
 * OPS-05's acceptance criterion, in its most checkable half: "aucune
 * variable de développement".
 *
 * Every value this repository ships for local convenience *works* — that is
 * exactly why it reaches production unnoticed. Nothing breaks; the door is
 * simply unlocked. So the assertions below are written against the literal
 * strings that live in this repo's own files, not against invented ones.
 */

const VALID = {
  NODE_ENV: "production",
  DATABASE_URL:
    "postgresql://kalloud:Un-Vrai-Secret-2026@db.exemple.fr:5432/kalloud?sslmode=require",
  OPS_METRICS_TOKEN: "a".repeat(MIN_SECRET_LENGTH),
};

function problemsFor(overrides: Record<string, string | undefined>): string[] {
  const report = checkProductionEnv({ ...VALID, ...overrides });
  return report.problems.map((problem: { variable: string }) => problem.variable);
}

describe("production configuration gate (OPS-05)", () => {
  it("accepts a genuinely production configuration", () => {
    const report = checkProductionEnv(VALID);
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("refuses the very .env this repository ships", () => {
    // Verbatim from .env.example — the file a hurried deploy copies.
    const report = checkProductionEnv({
      DATABASE_URL: "postgresql://kalloud:kalloud_dev_password@localhost:5433/kalloud",
      OPS_METRICS_TOKEN: "dev_metrics_token_change_me",
    });
    expect(report.ok).toBe(false);
    expect(report.problems.map((p: { variable: string }) => p.variable)).toEqual(
      expect.arrayContaining(["NODE_ENV", "DATABASE_URL", "OPS_METRICS_TOKEN"]),
    );
  });

  it("reports every problem at once rather than one per restart", () => {
    const report = checkProductionEnv({});
    expect(report.problems.length).toBeGreaterThan(2);
  });

  it("refuses a database on the loopback interface", () => {
    for (const host of ["localhost", "127.0.0.1"]) {
      expect(
        problemsFor({ DATABASE_URL: `postgresql://u:p@${host}:5432/kalloud?sslmode=require` }),
        `${host} must be refused`,
      ).toContain("DATABASE_URL");
    }
  });

  it("accepts a database reached by its container service name", () => {
    // docker-compose.prod.yml reaches Postgres at `postgres` over a private
    // network: an ordinary production topology, and the first version of
    // this gate rejected the very deployment it exists to protect.
    expect(
      problemsFor({ DATABASE_URL: "postgresql://kalloud:Secret-2026@postgres:5432/kalloud" }),
    ).not.toContain("DATABASE_URL");
  });

  it("refuses a database URL with no password", () => {
    expect(
      problemsFor({ DATABASE_URL: "postgresql://kalloud@db.exemple.fr:5432/kalloud" }),
    ).toContain("DATABASE_URL");
  });

  it("warns about plaintext database traffic without blocking a private network", () => {
    const report = checkProductionEnv({
      ...VALID,
      DATABASE_URL: "postgresql://kalloud:Secret-2026@postgres:5432/kalloud",
    });
    expect(report.ok).toBe(true);
    expect(report.warnings.map((w: { variable: string }) => w.variable)).toContain("DATABASE_URL");
  });

  it("refuses a metrics token that is too short to be a secret", () => {
    expect(problemsFor({ OPS_METRICS_TOKEN: "court" })).toContain("OPS_METRICS_TOKEN");
  });

  it("refuses an example token even when it is long enough", () => {
    // Padded past MIN_SECRET_LENGTH on purpose: an earlier version of this
    // test used the short literals from .env.example and
    // playwright.config.ts, so the length rule caught them and the
    // "this is an example value" rule was never exercised at all — it could
    // be deleted without failing anything.
    for (const example of ["dev_metrics_token_change_me", "e2e-ops-token"]) {
      expect(
        problemsFor({ OPS_METRICS_TOKEN: `${example}${"x".repeat(MIN_SECRET_LENGTH)}` }),
        `${example} must be refused on its own merits`,
      ).toContain("OPS_METRICS_TOKEN");
    }
  });

  it("requires a metrics token at all", () => {
    // Absent, OPS-02's endpoint refuses — monitoring would be silently
    // missing, which is the failure it exists to remove.
    expect(problemsFor({ OPS_METRICS_TOKEN: undefined })).toContain("OPS_METRICS_TOKEN");
  });

  it("refuses every escape hatch this codebase added for local work", () => {
    for (const variable of [
      "ALLOW_DEMO_SEED",
      "ALLOW_DESTRUCTIVE_DB_RESET",
      "ALLOW_RESTORE_OVER_APPLICATION_DB",
    ]) {
      expect(problemsFor({ [variable]: "true" }), `${variable} must be refused`).toContain(
        variable,
      );
    }
  });

  it("refuses the e2e suite's own rate limit", () => {
    // playwright.config.ts raises it to 1000 for the whole suite. In
    // production that is not a rate limit, it is an unlocked door (SEC-07).
    expect(problemsFor({ AUTH_RATE_LIMIT_MAX: "1000" })).toContain("AUTH_RATE_LIMIT_MAX");
    expect(problemsFor({ AUTH_RATE_LIMIT_MAX: "30" })).not.toContain("AUTH_RATE_LIMIT_MAX");
  });
});
