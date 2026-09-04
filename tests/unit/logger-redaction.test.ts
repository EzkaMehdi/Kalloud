import { describe, expect, it, vi, afterEach } from "vitest";
import { logger } from "../../lib/logger";

/**
 * OPS-08: the logger's contract is that a secret never reaches a log line
 * (OPS-01 "sans jamais exposer de secret", DEC-10 "les journaux ne
 * contiennent jamais de mot de passe ni de jeton de session en clair").
 *
 * Redaction used to walk only the top level, so the contract held because
 * every call site happened to pass scalars — a guard that lasts exactly as
 * long as everyone remembers. These assert the structure, not the habit.
 */

function captureLine(write: () => void): string {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  write();
  const line = spy.mock.calls.at(-1)?.[0] as string;
  spy.mockRestore();
  return line;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("log redaction (OPS-08)", () => {
  it("redacts a secret at the top level", () => {
    const line = captureLine(() => logger.warn("essai", { password: "Password123!" }));
    expect(line).not.toContain("Password123!");
    expect(line).toContain("[redacted]");
  });

  it("redacts a secret nested inside a request body", () => {
    // The shape someone reaches for when debugging: `{ body }`.
    const line = captureLine(() =>
      logger.warn("essai", {
        body: { email: "sarah@example.test", password: "Password123!" },
      }),
    );
    expect(line, "un mot de passe imbriqué ne doit jamais atteindre le journal").not.toContain(
      "Password123!",
    );
    // The rest of the object survives: redaction must not blind the operator.
    expect(line).toContain("sarah@example.test");
  });

  it("redacts secrets inside arrays", () => {
    const line = captureLine(() =>
      logger.warn("essai", { attempts: [{ token: "abc.def.ghi" }, { token: "jkl" }] }),
    );
    expect(line).not.toContain("abc.def.ghi");
    expect(line).not.toContain("jkl");
  });

  it("redacts every name the codebase uses for a secret", () => {
    const line = captureLine(() =>
      logger.warn("essai", {
        outer: {
          password: "p",
          passwordHash: "ph",
          password_hash: "phs",
          token: "t",
          tokenHash: "th",
          cookie: "c",
        },
      }),
    );
    // Compared as quoted JSON values, so a substring like "p" inside
    // another word cannot make the assertion pass by accident.
    for (const secret of ["p", "ph", "phs", "t", "th", "c"]) {
      expect(line, `la valeur ${secret} a fui`).not.toContain(`:"${secret}"`);
    }
    expect(line).toContain("[redacted]");
  });

  it("does not hang on a cyclic object", () => {
    const cyclic: Record<string, unknown> = { name: "boucle" };
    cyclic.self = cyclic;
    const line = captureLine(() => logger.warn("essai", { cyclic }));
    expect(line).toContain("[truncated]");
  });

  it("leaves ordinary diagnostic fields intact", () => {
    const line = captureLine(() =>
      logger.warn("essai", { statusCode: 409, durationMs: 12, endpoint: "/api/checkout" }),
    );
    expect(line).toContain("409");
    expect(line).toContain("/api/checkout");
  });
});
