#!/usr/bin/env node
// OPS-09: says whether this database is fit to hand to a pilot customer.
// Run it before go-live, and again after any restore. See docs/pilote.md.
import { Client } from "pg";
import { inspectPilotDatabase } from "./lib/pilote-core.mjs";

if (!process.env.DATABASE_URL) {
  console.error("[check-pilote] DATABASE_URL n'est pas définie.");
  process.exit(1);
}

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  const { findings, summary, ready } = await inspectPilotDatabase(client);

  console.log("[check-pilote] Contenu de la base :");
  for (const [label, count] of Object.entries(summary)) {
    console.log(`  ${label.padEnd(16)} ${count}`);
  }

  if (ready) {
    console.log("\n[check-pilote] ✓ Aucune donnée de démonstration ni reste de test.");
  } else {
    console.error("\n[check-pilote] ✗ Cette base n'est pas prête pour un pilote :");
    for (const finding of findings) {
      console.error(`  - ${finding.what} : ${finding.detail}`);
    }
    console.error(
      "\n  Une base pilote se construit par `pnpm db:migrate` puis l'inscription du client\n" +
        "  (SAAS-01) et l'import de son catalogue (`scripts/import-pilote.mjs`) — jamais par\n" +
        "  `pnpm db:seed`, qui existe pour le développement.",
    );
    process.exitCode = 1;
  }
} finally {
  await client.end();
}
