/**
 * CFG-01/GATE-4B: period boundaries in the establishment's own timezone.
 *
 * `new Date(year, month - 1, 1)` builds midnight in *the server's* timezone,
 * which is only the right answer when the server happens to sit in the same
 * zone as the restaurant. For a Paris establishment on a UTC server, every
 * month started and ended two hours late — quietly moving a late-evening
 * sale from the last day of one month into the first day of the next.
 *
 * There is no `Date` constructor that takes a timezone, so the instant is
 * found by asking `Intl` what a candidate UTC instant looks like in the
 * target zone, and correcting by the difference. One correction is enough
 * for every real zone; a second pass covers the hour around a DST change,
 * where the first correction can land just on the wrong side of the shift.
 */

/** True when `timeZone` is an IANA zone this runtime knows. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** How far `timeZone` is ahead of UTC at `instant`, in milliseconds. */
function offsetMs(instant: Date, timeZone: string): number {
  // `en-CA` gives an ISO-ish "YYYY-MM-DD, HH:MM:SS" that parses reliably.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(instant);
  const [date, time] = parts.split(", ");
  const asUtc = Date.parse(`${date}T${time.replace("24:", "00:")}Z`);
  return asUtc - instant.getTime();
}

/**
 * The instant at which the given wall-clock time occurs in `timeZone`.
 * Months are 1-based, matching how they are written and stored.
 */
export function zonedTime(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour = 0,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour);
  let instant = new Date(naive - offsetMs(new Date(naive), timeZone));
  // Second pass: around a DST transition the first offset can be the one
  // from the wrong side of the shift.
  instant = new Date(naive - offsetMs(instant, timeZone));
  return instant;
}

/**
 * BI-12: `instant` written as local wall-clock time in `timeZone`, with an
 * explicit numeric offset (`2026-08-04T19:30:00+02:00`) — the exact shape
 * `DEC-09`'s CSV export format requires, and deliberately not
 * `Date.prototype.toISOString()`, which only ever produces UTC (`Z`) and
 * would leave a reader of the export doing the timezone arithmetic
 * themselves for every single row.
 */
export function formatZonedIso(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  // Same midnight quirk `offsetMs` above already works around: some ICU
  // builds render midnight as hour "24" rather than "00" under `hour12:
  // false`.
  const hour = get("hour") === "24" ? "00" : get("hour");
  const local = `${get("year")}-${get("month")}-${get("day")}T${hour}:${get("minute")}:${get("second")}`;

  const offsetMinutes = Math.round(offsetMs(instant, timeZone) / 60_000);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absMinutes = Math.abs(offsetMinutes);
  const offsetHours = String(Math.floor(absMinutes / 60)).padStart(2, "0");
  const offsetRemainder = String(absMinutes % 60).padStart(2, "0");
  return `${local}${sign}${offsetHours}:${offsetRemainder}`;
}

/**
 * Today's calendar date as seen in `timeZone`. `day` was added by BI-03,
 * which needs to default a specific-day query to "today" the same way
 * `month`/`year` queries already default to the current month/year —
 * additive on the return shape, so existing callers destructuring only
 * `{ year, month }` are unaffected.
 */
export function zonedToday(
  timeZone: string,
  now = new Date(),
): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const day = Number(parts.find((part) => part.type === "day")?.value);
  return { year, month, day };
}
