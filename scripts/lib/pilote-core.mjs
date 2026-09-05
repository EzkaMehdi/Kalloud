/**
 * OPS-09: "données de démo séparées des données pilote".
 *
 * `FND-14` already stops `seed.mjs` from running with `NODE_ENV=production`,
 * and `OPS-05`'s configuration gate refuses `ALLOW_DEMO_SEED`. Both are
 * *preventive*: they stop the demo tenant being created. Neither answers the
 * question an operator actually asks before handing an establishment to a
 * real customer — **is any of it in here right now?** A database restored
 * from a developer's dump, or seeded before the guards existed, passes both
 * and is still full of "Kalloud Lounge".
 *
 * So this checks the data rather than the intent.
 */

/** The rows `scripts/seed.mjs` creates, by the markers only it uses. */
const DEMO_MARKERS = {
  users: ["owner@kalloud.test", "manager@kalloud.test", "cashier@kalloud.test"],
  organizations: ["Kalloud Lounge"],
};

/** Fixtures the test suites leave behind; harmless locally, never wanted in a pilot. */
const TEST_PATTERNS = {
  products: ["Test %"],
  dining_tables: ["Test table %", "T-%"],
  organizations: ["E2E %"],
  users: ["%@example.test"],
};

export async function inspectPilotDatabase(db) {
  const findings = [];

  const { rows: demoUsers } = await db.query(
    "SELECT email FROM users WHERE lower(email) = ANY($1)",
    [DEMO_MARKERS.users],
  );
  if (demoUsers.length > 0) {
    findings.push({
      severity: "blocking",
      what: "comptes de démonstration",
      detail: demoUsers.map((row) => row.email).join(", "),
    });
  }

  const { rows: demoOrgs } = await db.query("SELECT name FROM organizations WHERE name = ANY($1)", [
    DEMO_MARKERS.organizations,
  ]);
  if (demoOrgs.length > 0) {
    findings.push({
      severity: "blocking",
      what: "établissement de démonstration",
      detail: demoOrgs.map((row) => row.name).join(", "),
    });
  }

  for (const [table, patterns] of Object.entries(TEST_PATTERNS)) {
    const { rows } = await db.query(
      `SELECT COUNT(*)::TEXT AS count FROM ${table} WHERE ${table === "users" ? "email" : "name"} LIKE ANY($1)`,
      [patterns],
    );
    const count = Number(rows[0].count);
    if (count > 0) {
      findings.push({
        severity: "blocking",
        what: `restes de tests dans ${table}`,
        detail: `${count} ligne(s)`,
      });
    }
  }

  const { rows: summary } = await db.query(
    `SELECT (SELECT COUNT(*)::INT FROM organizations) AS organisations,
            (SELECT COUNT(*)::INT FROM locations)     AS etablissements,
            (SELECT COUNT(*)::INT FROM users)         AS comptes,
            (SELECT COUNT(*)::INT FROM products)      AS produits,
            (SELECT COUNT(*)::INT FROM dining_tables) AS tables,
            (SELECT COUNT(*)::INT FROM orders)        AS commandes`,
  );

  return { findings, summary: summary[0], ready: findings.length === 0 };
}
