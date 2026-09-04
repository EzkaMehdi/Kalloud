#!/usr/bin/env node
// OPS-04: the operator's tool for a customer's data request — DEC-10's
// export, anonymisation and purge. Deliberately a CLI and not a screen:
// these are rare, irreversible acts performed by the designated operator
// (OPS-09), not by an establishment's own owner from a page they could
// reach by accident.
//
//   node --env-file=.env scripts/data-request.mjs status --location 1
//   node --env-file=.env scripts/data-request.mjs export --location 1 [--out fichier.json]
//   node --env-file=.env scripts/data-request.mjs anonymize --user 4
//   node --env-file=.env scripts/data-request.mjs purge --location 1 --confirm
import { writeFile } from "node:fs/promises";
import { Client } from "pg";
import {
  anonymizeUser,
  exportEstablishmentArchive,
  getRetentionStatus,
  purgeEstablishment,
} from "./lib/retention-core.mjs";

const [command, ...rest] = process.argv.slice(2);
const options = parseArgs(rest);

if (!process.env.DATABASE_URL) {
  console.error("[data-request] DATABASE_URL is not set.");
  process.exit(1);
}

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

try {
  switch (command) {
    case "status":
      await status(requireLocation());
      break;
    case "export":
      await exportArchive(requireLocation(), options.out);
      break;
    case "anonymize":
      await anonymize(requireUser());
      break;
    case "purge":
      await purge(requireLocation());
      break;
    default:
      usage();
      process.exitCode = command ? 1 : 0;
  }
} catch (error) {
  console.error(`[data-request] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await client.end();
}

async function status(locationId) {
  const retention = await getRetentionStatus(client, locationId);
  console.log(`Établissement ${locationId} — conservation ${retention.retentionYears} ans`);
  console.log(`Limite de conservation : ${retention.boundary}`);
  for (const entry of retention.protectedRows) {
    console.log(
      `  ${entry.table.padEnd(18)} ${String(entry.rows).padStart(6)} ligne(s) protégée(s)` +
        (entry.newest ? `  (plus récente : ${entry.newest})` : ""),
    );
  }
  console.log(
    retention.purgeAllowed
      ? "Purge complète : autorisée (plus aucune obligation comptable applicable)."
      : `Purge complète : refusée — ${retention.totalProtectedRows} enregistrement(s) protégé(s). ` +
          `Possible à partir du ${retention.purgeAllowedFrom}.`,
  );
  console.log("Anonymisation des comptes : toujours possible (DEC-10, sous 30 jours).");
}

async function exportArchive(locationId, out) {
  const archive = await exportEstablishmentArchive(client, locationId);
  const path = out ?? `export-etablissement-${locationId}-${archive.exportedAt.slice(0, 10)}.json`;
  await writeFile(path, `${JSON.stringify(archive, null, 2)}\n`);
  console.log(
    `[data-request] Archive écrite : ${path} — ${archive.orders.length} commande(s), ` +
      `${archive.payments.length} paiement(s), ${archive.auditEvents.length} événement(s) d'audit, ` +
      `${archive.members.length} membre(s).`,
  );
  console.log(
    "[data-request] Cette archive contient des données personnelles : transmettez-la par un canal sûr, ne la conservez pas.",
  );
}

async function anonymize(userId) {
  // One transaction: an account left half-erased — credentials revoked but
  // the name still readable — would be worse than one not yet processed.
  const result = await inTransaction(() => anonymizeUser(client, userId));
  console.log(
    `[data-request] Compte ${result.userId} anonymisé → ${result.email}. ` +
      `Sessions révoquées, jetons supprimés. Audité sur ${result.locationsAudited.length} établissement(s).`,
  );
  console.log(
    "[data-request] Irréversible : l'écriture comptable reste attribuée à cet identifiant, la personne n'est plus identifiable.",
  );
}

async function purge(locationId) {
  if (!options.confirm) {
    console.error(
      "[data-request] Purge refusée : ajoutez --confirm.\n" +
        "              DEC-10 exige une confirmation explicite du client, et un export préalable\n" +
        "              (`export`) est fortement recommandé — la purge est irréversible.",
    );
    process.exitCode = 1;
    return;
  }
  const result = await inTransaction(() =>
    purgeEstablishment(client, locationId, { confirm: true }),
  );
  console.log(`[data-request] Établissement ${result.locationId} purgé :`);
  for (const [table, rows] of Object.entries(result.deleted)) {
    console.log(`  ${table.padEnd(18)} ${String(rows).padStart(6)} ligne(s) supprimée(s)`);
  }
}

async function inTransaction(fn) {
  await client.query("BEGIN");
  try {
    const result = await fn();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

function requireLocation() {
  if (!options.location) throw new Error("Indiquez --location <id>.");
  return options.location;
}

function requireUser() {
  if (!options.user) throw new Error("Indiquez --user <id>.");
  return options.user;
}

function parseArgs(argv) {
  const parsed = { location: null, user: null, out: null, confirm: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--location") parsed.location = Number(argv[++index]);
    else if (argv[index] === "--user") parsed.user = Number(argv[++index]);
    else if (argv[index] === "--out") parsed.out = argv[++index];
    else if (argv[index] === "--confirm") parsed.confirm = true;
  }
  return parsed;
}

function usage() {
  console.log(
    [
      "Demandes de données (OPS-04 / DEC-10)",
      "",
      "  status    --location <id>            Ce que la conservation protège encore",
      "  export    --location <id> [--out f]  Archive complète (export préalable)",
      "  anonymize --user <id>                Anonymise un compte, irréversible",
      "  purge     --location <id> --confirm  Purge complète, refusée si des obligations subsistent",
    ].join("\n"),
  );
}
