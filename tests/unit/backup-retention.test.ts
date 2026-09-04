import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain JS module shared with the CLI scripts, same precedent as tests/e2e/global-teardown.ts
import { selectExpired } from "../../scripts/lib/backup-core.mjs";

/**
 * OPS-03: DEC-10's retention — "30 jours glissants de sauvegardes
 * quotidiennes, puis une sauvegarde hebdomadaire conservée 3 mois."
 *
 * Tested on its own because a retention bug is the one kind that hides: it
 * deletes quietly, and the result is indistinguishable from having no
 * backups at all until the day someone needs one.
 */

const NOW = new Date("2026-09-04T03:00:00Z");
const DAY = 86_400_000;

function backup(daysAgo: number, hour = 3) {
  const takenAt = new Date(NOW.getTime() - daysAgo * DAY);
  takenAt.setUTCHours(hour, 0, 0, 0);
  return { name: `kalloud-${takenAt.toISOString()}`, manifest: { takenAt: takenAt.toISOString() } };
}

describe("backup retention (OPS-03/DEC-10)", () => {
  it("keeps every backup from the last 30 days", () => {
    const backups = [0, 1, 7, 15, 29].map((days) => backup(days));
    expect(selectExpired(backups, NOW)).toEqual([]);
  });

  it("keeps one backup per week beyond 30 days", () => {
    // Four days inside the same ISO week, all older than 30 days: three go,
    // the newest stays.
    const week = [40, 41, 42, 43].map((days) => backup(days));
    const expired = selectExpired(week, NOW);

    expect(expired).toHaveLength(3);
    expect(expired).not.toContain(week[0].name);
  });

  it("keeps a weekly for each distinct week", () => {
    const weeks = [40, 47, 54, 61].map((days) => backup(days));
    expect(selectExpired(weeks, NOW)).toEqual([]);
  });

  it("drops everything past three months", () => {
    const ancient = backup(120);
    expect(selectExpired([ancient], NOW)).toEqual([ancient.name]);
  });

  it("keeps anything it cannot date rather than guessing", () => {
    // Conservative on purpose: deleting a backup because its manifest is
    // unreadable is the failure that cannot be undone.
    const broken = { name: "kalloud-broken", manifest: { takenAt: "pas une date" } };
    expect(selectExpired([broken], NOW)).toEqual([]);
  });

  it("never empties the store when every backup is recent", () => {
    const daily = Array.from({ length: 30 }, (_, index) => backup(index));
    expect(selectExpired(daily, NOW)).toEqual([]);
  });
});
