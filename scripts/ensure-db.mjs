#!/usr/bin/env node
// FND-10: the single entry point that gets a developer from a fresh clone to
// a running database without a manual, undocumented step. Refuses to guess
// when the target does not look local, per FND-14 (no destructive or
// automatic action against anything that could be a real environment).
import { spawnSync } from "node:child_process";
import { isReachable, isLocalDatabaseUrl, waitUntilReachable } from "./lib/pg-wait.mjs";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error("[ensure-db] DATABASE_URL is not set. Copy .env.example to .env and try again.");
  process.exit(1);
}

if (await isReachable(connectionString)) {
  console.log("[ensure-db] Database already reachable.");
  process.exit(0);
}

if (!isLocalDatabaseUrl(connectionString)) {
  console.error(
    "[ensure-db] Database is unreachable and DATABASE_URL does not point at a local " +
      "host, so it will not be started automatically. Start the target database yourself " +
      "and re-run this command.",
  );
  process.exit(1);
}

console.log("[ensure-db] Database not reachable yet; starting `docker compose up -d postgres`...");
const result = spawnSync("docker", ["compose", "up", "-d", "postgres"], { stdio: "inherit" });
if (result.status !== 0) {
  console.error(
    "[ensure-db] Could not start Postgres via Docker Compose. Is Docker Desktop running?",
  );
  process.exit(1);
}

console.log("[ensure-db] Waiting for Postgres to accept connections...");
const ready = await waitUntilReachable(connectionString, { timeoutMs: 60_000, intervalMs: 1000 });
if (!ready) {
  console.error("[ensure-db] Postgres did not become reachable within 60s.");
  process.exit(1);
}

console.log("[ensure-db] Postgres is ready.");
