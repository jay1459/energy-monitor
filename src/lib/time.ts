import { DateTime } from "luxon";

/**
 * Time helpers. The Octopus API mixes `Z` and `+01:00` offsets within a
 * single response across DST boundaries, and buckets days by Europe/London
 * local time (46/48/50 half-hours per day). Rules:
 *   - store UTC ISO strings ("2026-07-08T14:30:00Z"),
 *   - bucket by Europe/London calendar days,
 *   - never assume 48 half-hours in a day.
 */

export const LONDON = "Europe/London";

/** Canonical storage format: UTC, second precision, trailing Z. */
export function utcIso(dt: DateTime): string {
  const iso = dt.toUTC().startOf("second").toISO({ suppressMilliseconds: true });
  if (!iso) throw new Error(`invalid DateTime: ${dt.invalidReason}`);
  return iso;
}

/** Parse any ISO-8601 instant (any offset) to a UTC DateTime. Throws on garbage. */
export function parseInstant(iso: string): DateTime {
  const dt = DateTime.fromISO(iso, { setZone: true });
  if (!dt.isValid) throw new Error(`invalid ISO instant: ${iso}`);
  return dt.toUTC();
}

/** Normalize any ISO instant (e.g. "…+01:00" from the API) to canonical UTC form. */
export function normalizeInstant(iso: string): string {
  return utcIso(parseInstant(iso));
}

export function nowUtc(): DateTime {
  return DateTime.utc();
}

export function nowUtcIso(): string {
  return utcIso(DateTime.utc());
}

/** Europe/London calendar date ("yyyy-MM-dd") an instant falls on. */
export function localDayOf(utcInstant: string): string {
  return parseInstant(utcInstant).setZone(LONDON).toISODate()!;
}

export function todayLocal(): string {
  return DateTime.now().setZone(LONDON).toISODate()!;
}

/** Parse a "yyyy-MM-dd" local date; throws on garbage. */
export function parseLocalDate(date: string): DateTime {
  const dt = DateTime.fromISO(date, { zone: LONDON });
  if (!dt.isValid || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`invalid local date: ${date}`);
  }
  return dt.startOf("day");
}

/** UTC bounds [start, end) of a Europe/London calendar day. */
export function localDayBoundsUtc(date: string): { startUtc: string; endUtc: string } {
  const start = parseLocalDate(date);
  const end = start.plus({ days: 1 }).startOf("day");
  return { startUtc: utcIso(start), endUtc: utcIso(end) };
}

/** Number of half-hour intervals in a local day: 46 (spring forward), 48, or 50. */
export function halfHoursInLocalDay(date: string): number {
  const { startUtc, endUtc } = localDayBoundsUtc(date);
  const minutes = parseInstant(endUtc).diff(parseInstant(startUtc), "minutes").minutes;
  return Math.round(minutes / 30);
}

/** Add days to a "yyyy-MM-dd" local date. */
export function addLocalDays(date: string, days: number): string {
  return parseLocalDate(date).plus({ days }).toISODate()!;
}

/** Inclusive day count of a local-date range (assumes from <= to). */
export function localDaySpan(from: string, to: string): number {
  return Math.round(parseLocalDate(to).diff(parseLocalDate(from), "days").days) + 1;
}

/** Inclusive list of local dates from `from` to `to`. */
export function localDateRange(from: string, to: string): string[] {
  const out: string[] = [];
  let d = parseLocalDate(from);
  const end = parseLocalDate(to);
  while (d <= end) {
    out.push(d.toISODate()!);
    d = d.plus({ days: 1 });
  }
  return out;
}
