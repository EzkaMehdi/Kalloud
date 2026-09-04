import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * OPS-03: how old the newest usable backup is, read from the manifests
 * `scripts/backup.mjs` writes beside each dump.
 *
 * Reads the manifest rather than the file's mtime: a dump can be copied,
 * synced or touched long after it was taken, and an RPO answered from a
 * timestamp that means "when this file last moved" would report a fresh
 * backup on a schedule that stopped weeks ago. `takenAt` is the only
 * timestamp that means what the RPO asks about.
 *
 * A manifest with no dump beside it is ignored: an interrupted run must not
 * make the freshness check pass on something nobody can restore.
 */
export async function lastBackupAgeHours(
  directory = process.env.BACKUP_DIR ?? "backups",
  now: Date = new Date(),
): Promise<number | null> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return null;
  }

  let newest: number | null = null;
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const name = entry.slice(0, -".json".length);
    if (!entries.includes(`${name}.dump`)) continue;
    try {
      const manifest = JSON.parse(await readFile(join(directory, entry), "utf8")) as {
        takenAt?: string;
      };
      const takenAt = manifest.takenAt ? Date.parse(manifest.takenAt) : NaN;
      if (Number.isNaN(takenAt)) continue;
      if (newest === null || takenAt > newest) newest = takenAt;
    } catch {
      // An unreadable manifest is not a backup.
    }
  }

  if (newest === null) return null;
  return Math.max(0, Math.floor((now.getTime() - newest) / 3_600_000));
}
