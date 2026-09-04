#!/usr/bin/env node
// OPS-03: restores a backup into a target database, and refuses by default
// to restore over the application's own. DEC-10 requires the procedure to be
// exercised on an isolated environment before any go-live, and this is the
// script that exercise runs.
//
//   node --env-file=.env scripts/restore.mjs --list
//   node --env-file=.env scripts/restore.mjs --into kalloud_restore_drill
//   node --env-file=.env scripts/restore.mjs --backup <nom> --into <base>
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { Client } from "pg";
import {
  BACKUP_DIR,
  connectionArgs,
  listBackups,
  resolveTool,
  run,
  sha256,
} from "./lib/backup-core.mjs";
import { isLocalDatabaseUrl } from "./lib/pg-wait.mjs";

const options = parseArgs(process.argv.slice(2));
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("[restore] DATABASE_URL is not set.");
  process.exit(1);
}

const backups = await listBackups(BACKUP_DIR);
if (options.list) {
  if (backups.length === 0) console.log("[restore] Aucune sauvegarde dans", BACKUP_DIR);
  for (const backup of backups) {
    console.log(
      `${backup.name}  ${backup.manifest.takenAt}  ${(backup.bytes / 1024 / 1024).toFixed(2)} Mo  schéma ${backup.manifest.schemaVersion ?? "?"}`,
    );
  }
  process.exit(0);
}

const backup = options.backup ? backups.find((entry) => entry.name === options.backup) : backups[0];
if (!backup) {
  console.error(
    options.backup
      ? `[restore] Sauvegarde "${options.backup}" introuvable dans ${BACKUP_DIR}.`
      : `[restore] Aucune sauvegarde dans ${BACKUP_DIR}. Lancez d'abord \`pnpm db:backup\`.`,
  );
  process.exit(1);
}

const sourceUrl = new URL(connectionString);
const sourceDatabase = decodeURIComponent(sourceUrl.pathname.replace(/^\//, ""));
const target = options.into ?? `${sourceDatabase}_restore_drill`;

/**
 * The guard DEC-10 asks for, in code rather than in a runbook: "la
 * restauration doit être testée sur un environnement isolé (jamais
 * directement en production)". Restoring is destructive — the target
 * database is dropped and rebuilt — so the one mistake this script must make
 * impossible is doing that to the live database because someone forgot a
 * flag.
 */
if (target === sourceDatabase && process.env.ALLOW_RESTORE_OVER_APPLICATION_DB !== "true") {
  console.error(
    `[restore] Refus de restaurer par-dessus la base applicative "${sourceDatabase}".\n` +
      `          Indiquez une base isolée avec --into, ou, en connaissance de cause,\n` +
      `          relancez avec ALLOW_RESTORE_OVER_APPLICATION_DB=true.`,
  );
  process.exit(1);
}

// Integrity before anything is dropped: a corrupted dump discovered *after*
// the target has been emptied leaves nothing at all.
const digest = await sha256(backup.path);
if (digest !== backup.manifest.sha256) {
  console.error(
    `[restore] Empreinte incorrecte pour ${backup.name}.\n` +
      `          attendu ${backup.manifest.sha256}\n` +
      `          obtenu  ${digest}\n` +
      `          La sauvegarde est corrompue : ne restaurez pas depuis ce fichier.`,
  );
  process.exit(1);
}

const startedAt = Date.now();
console.log(`[restore] ${backup.name} (${backup.manifest.takenAt}) → base "${target}"`);

// Recreating the target requires a connection to another database on the
// same server; `postgres` always exists.
const adminUrl = new URL(connectionString);
adminUrl.pathname = "/postgres";
const admin = new Client({ connectionString: adminUrl.toString() });
await admin.connect();
try {
  if (!isLocalDatabaseUrl(connectionString) && !options.into) {
    throw new Error(
      "Sur une base distante, indiquez explicitement --into : aucune base de secours n'est devinée.",
    );
  }
  await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(target)} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${quoteIdent(target)}`);
} finally {
  await admin.end();
}

const targetUrl = new URL(connectionString);
targetUrl.pathname = `/${target}`;
const tool = await resolveTool("pg_restore", connectionString);
const { args, env } = connectionArgs(targetUrl.toString(), tool);

// `--single-transaction`: the restore either lands whole or leaves an empty
// database. A half-restored database that answers queries is the outcome
// most likely to be mistaken for a working one.
const restoreArgs = [...args, "--no-owner", "--no-acl", "--single-transaction"];
if (tool.containerised) {
  // The dump lives on the host; pg_restore runs in the container, so the
  // file is streamed in on stdin rather than named as a path that does not
  // exist there.
  await runWithStdin(tool, restoreArgs, backup.path, env);
} else {
  await run(tool, [...restoreArgs, backup.path], { env });
}

const durationMs = Date.now() - startedAt;
const verifier = new Client({ connectionString: targetUrl.toString() });
await verifier.connect();
try {
  const { rows: migrations } = await verifier.query(
    "SELECT MAX(id) AS version, COUNT(*)::INT AS applied FROM schema_migrations",
  );
  const { rows: counts } = await verifier.query(
    `SELECT (SELECT COUNT(*)::INT FROM organizations) AS organizations,
            (SELECT COUNT(*)::INT FROM orders) AS orders,
            (SELECT COUNT(*)::INT FROM payments) AS payments,
            (SELECT COUNT(*)::INT FROM audit_events) AS audit_events`,
  );
  console.log(
    `[restore] Terminé en ${(durationMs / 1000).toFixed(1)} s — schéma ${migrations[0].version} ` +
      `(${migrations[0].applied} migrations), ${counts[0].organizations} organisation(s), ` +
      `${counts[0].orders} commande(s), ${counts[0].payments} paiement(s), ` +
      `${counts[0].audit_events} événement(s) d'audit.`,
  );
  if (migrations[0].version !== backup.manifest.schemaVersion) {
    console.warn(
      `[restore] Attention : le manifeste annonçait le schéma ${backup.manifest.schemaVersion}.`,
    );
  }
  // DEC-10 fixes the RTO at 4 working hours; this only reports the database
  // step, which is the part this script owns.
  console.log(
    `[restore] Étape base : ${(durationMs / 1000).toFixed(1)} s. RTO DEC-10 : 4 h ouvrées pour ` +
      `l'environnement complet (application, secrets, DNS).`,
  );
} finally {
  await verifier.end();
}

function runWithStdin(tool, args, path, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(tool.command, [...tool.args, ...args], {
      stdio: ["pipe", "inherit", "pipe"],
      env,
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    createReadStream(path).pipe(child.stdin);
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`pg_restore a échoué (code ${code}) :\n${stderr.trim()}`)),
    );
  });
}

function quoteIdent(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Nom de base invalide : "${name}".`);
  }
  return `"${name}"`;
}

function parseArgs(argv) {
  const options = { list: false, backup: null, into: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--list") options.list = true;
    else if (argv[index] === "--backup") options.backup = argv[++index];
    else if (argv[index] === "--into") options.into = argv[++index];
  }
  return options;
}
