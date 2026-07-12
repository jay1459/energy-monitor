import { getConfig } from "@/lib/config";
import {
  findAgreementAt,
  halfHourCostP,
  loadAgreements,
  loadUnitRates,
  resolveUnitRate,
} from "@/lib/costs";
import { getDb } from "@/lib/db";
import {
  LONDON,
  addLocalDays,
  localDateRange,
  localDayBoundsUtc,
  localDayOf,
  nowUtcIso,
  parseInstant,
  parseLocalDate,
  todayLocal,
} from "@/lib/time";
import type {
  Agreement,
  Fuel,
  HeatmapDay,
  InsightsResponse,
  UnitRateRow,
} from "@/lib/types";

/**
 * Usage-pattern analytics for /api/insights. Reads SQLite only (never the
 * Octopus API). All bucketing is Europe/London via lib/time.ts.
 *
 * Contract details live on InsightsResponse in lib/types.ts. Key rules:
 * - Heatmap: last 8 weeks of local days (or fewer while history is short —
 *   start at the oldest stored day), each folded onto a 48-slot local clock
 *   (sum the repeated hour on 50-half-hour days; leave the skipped hour null
 *   on 46-half-hour days). maxKwh = largest cell.
 * - Baseload: median kWh of 01:00–05:00 local half-hours over the last 28
 *   COMPLETE days (per daily_costs); watts = medianKwh × 2000. Annual cost
 *   uses the current unit rate (reuse lib/costs.ts loaders + resolveUnitRate
 *   with the configured payment method): watts/1000 × 8760 h × p/kWh.
 *   Null watts/annualCostP when fewer than 7 sample days.
 * - weekCompare: "this week" = the ISO week (Mon–Sun) containing the newest
 *   COMPLETE day; "last week" = the one before. Sum per local day; a day
 *   with no complete daily_costs row is null (not 0).
 * - peaks: top 5 half-hours by kWh over the last 30 local days, costP priced
 *   like lib/aggregate.ts's half-hour path (null when no rate known).
 *
 * All windows are anchored to the DATA (newest stored / newest complete
 * local day), not the wall clock, so a lagging collector still yields the
 * most recent 8 weeks of history rather than a blank tail.
 */

const HEATMAP_WINDOW_DAYS = 56;
const BASELOAD_WINDOW_DAYS = 28;
const BASELOAD_MIN_SAMPLE_DAYS = 7;
/** Overnight sampling window, local clock hours [start, end). */
const BASELOAD_HOUR_START = 1;
const BASELOAD_HOUR_END = 5;
const PEAKS_WINDOW_DAYS = 30;
const PEAKS_COUNT = 5;

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/**
 * The zero-data response shape — used when the fuel has no import meter or
 * no stored consumption, and by the API route's setup-mode fallback.
 */
export function emptyInsights(fuel: Fuel): InsightsResponse {
  const today = todayLocal();
  return {
    fuel,
    heatmap: { from: today, to: today, days: [], maxKwh: 0 },
    baseload: { watts: null, annualCostP: null, sampleDays: 0 },
    weekCompare: {
      days: WEEKDAY_LABELS.map((weekday) => ({
        weekday,
        thisWeekKwh: null,
        lastWeekKwh: null,
      })),
      thisWeekTotalKwh: 0,
      lastWeekTotalKwh: 0,
      deltaPct: null,
    },
    peaks: [],
    generatedAt: nowUtcIso(),
  };
}

interface ConsumptionSlice {
  intervalStart: string;
  kwh: number;
}

/** Middle value (mean of the two middles for even counts). Input not empty. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function getInsights(fuel: Fuel): InsightsResponse {
  const db = getDb();
  const meter = db
    .prepare(
      "SELECT id FROM meter_points WHERE fuel = ? AND is_export = 0 ORDER BY id LIMIT 1"
    )
    .get(fuel) as { id: number } | undefined;
  if (!meter) return emptyInsights(fuel);

  const bounds = db
    .prepare(
      `SELECT MIN(interval_start) AS oldest, MAX(interval_start) AS newest
         FROM consumption WHERE meter_point_id = ?`
    )
    .get(meter.id) as { oldest: string | null; newest: string | null };
  if (!bounds.newest || !bounds.oldest) return emptyInsights(fuel);

  const selectRange = db.prepare(
    `SELECT interval_start AS intervalStart, kwh FROM consumption
      WHERE meter_point_id = ? AND interval_start >= ? AND interval_start < ?
      ORDER BY interval_start`
  );

  const config = getConfig();
  const agreements = loadAgreements(meter.id);
  // One rate-set load per tariff, shared by peaks pricing and baseload.
  const ratesByTariff = new Map<string, UnitRateRow[]>();
  const unitRatesFor = (tariffCode: string): UnitRateRow[] => {
    let rows = ratesByTariff.get(tariffCode);
    if (!rows) {
      rows = loadUnitRates(tariffCode);
      ratesByTariff.set(tariffCode, rows);
    }
    return rows;
  };

  // --- Heatmap: last 56 local days ending at the newest stored day ---------
  const newestDay = localDayOf(bounds.newest);
  const oldestDay = localDayOf(bounds.oldest);
  let heatFrom = addLocalDays(newestDay, -(HEATMAP_WINDOW_DAYS - 1));
  if (heatFrom < oldestDay) heatFrom = oldestDay;

  const heatDates = localDateRange(heatFrom, newestDay);
  const dayIndex = new Map<string, number>(heatDates.map((d, i) => [d, i]));
  const heatDays: HeatmapDay[] = heatDates.map((date) => ({
    date,
    kwh: new Array<number | null>(48).fill(null),
  }));
  let maxKwh = 0;

  const heatRows = selectRange.all(
    meter.id,
    localDayBoundsUtc(heatFrom).startUtc,
    localDayBoundsUtc(newestDay).endUtc
  ) as ConsumptionSlice[];
  for (const row of heatRows) {
    const local = parseInstant(row.intervalStart).setZone(LONDON);
    const idx = dayIndex.get(local.toISODate()!);
    if (idx === undefined) continue;
    const slot = local.hour * 2 + Math.floor(local.minute / 30);
    // Sum collisions: the repeated 01:xx hour on the 50-half-hour day folds
    // two UTC half-hours onto one local slot.
    const cell = (heatDays[idx].kwh[slot] ?? 0) + row.kwh;
    heatDays[idx].kwh[slot] = cell;
    if (cell > maxKwh) maxKwh = cell;
  }

  // --- Baseload: median overnight half-hour over last 28 complete days -----
  const completeDates = (
    db
      .prepare(
        `SELECT local_date AS d FROM daily_costs
          WHERE meter_point_id = ? AND intervals_present >= intervals_expected
          ORDER BY local_date DESC LIMIT ?`
      )
      .all(meter.id, BASELOAD_WINDOW_DAYS) as { d: string }[]
  ).map((r) => r.d);

  const samples: number[] = [];
  const sampleDates = new Set<string>();
  if (completeDates.length > 0) {
    const completeSet = new Set(completeDates);
    const first = completeDates[completeDates.length - 1]; // DESC order
    const last = completeDates[0];
    const rows = selectRange.all(
      meter.id,
      localDayBoundsUtc(first).startUtc,
      localDayBoundsUtc(last).endUtc
    ) as ConsumptionSlice[];
    for (const row of rows) {
      const local = parseInstant(row.intervalStart).setZone(LONDON);
      if (local.hour < BASELOAD_HOUR_START || local.hour >= BASELOAD_HOUR_END) continue;
      const date = local.toISODate()!;
      if (!completeSet.has(date)) continue;
      samples.push(row.kwh);
      sampleDates.add(date);
    }
  }

  const sampleDays = sampleDates.size;
  let watts: number | null = null;
  let annualCostP: number | null = null;
  if (sampleDays >= BASELOAD_MIN_SAMPLE_DAYS) {
    // A half-hour's kWh × 2 = average kW over it; × 1000 = watts.
    watts = median(samples) * 2000;
    const now = nowUtcIso();
    const agreement = findAgreementAt(agreements, now);
    const rate = agreement
      ? resolveUnitRate(unitRatesFor(agreement.tariffCode), now, config.paymentMethod)
      : null;
    if (rate) annualCostP = (watts / 1000) * 8760 * rate.pIncVat;
  }

  // --- weekCompare: ISO week (Mon–Sun) of the newest complete day ----------
  const newestComplete = db
    .prepare(
      `SELECT MAX(local_date) AS d FROM daily_costs
        WHERE meter_point_id = ? AND intervals_present >= intervals_expected`
    )
    .get(meter.id) as { d: string | null };
  // No complete day yet: today's week, which yields all-null days.
  const weekAnchor = newestComplete.d ?? todayLocal();
  const monday = parseLocalDate(weekAnchor).startOf("week").toISODate()!; // luxon weeks are ISO: Monday start

  const dayStmt = db.prepare(
    `SELECT kwh, intervals_present AS present, intervals_expected AS expected
       FROM daily_costs WHERE meter_point_id = ? AND local_date = ?`
  );
  const completeKwh = (date: string): number | null => {
    const row = dayStmt.get(meter.id, date) as
      | { kwh: number; present: number; expected: number }
      | undefined;
    return row && row.present >= row.expected ? row.kwh : null;
  };

  let thisWeekTotalKwh = 0;
  let lastWeekTotalKwh = 0;
  // The headline delta must be like-for-like: an in-progress week (1-3
  // complete days) against a full previous week would claim a huge "drop"
  // every day. Only weekdays complete in BOTH weeks feed the delta.
  let matchedThisKwh = 0;
  let matchedLastKwh = 0;
  const weekDays = WEEKDAY_LABELS.map((weekday, i) => {
    const thisWeekKwh = completeKwh(addLocalDays(monday, i));
    const lastWeekKwh = completeKwh(addLocalDays(monday, i - 7));
    thisWeekTotalKwh += thisWeekKwh ?? 0;
    lastWeekTotalKwh += lastWeekKwh ?? 0;
    if (thisWeekKwh !== null && lastWeekKwh !== null) {
      matchedThisKwh += thisWeekKwh;
      matchedLastKwh += lastWeekKwh;
    }
    return { weekday: weekday as string, thisWeekKwh, lastWeekKwh };
  });
  const deltaPct =
    matchedLastKwh === 0 ? null : ((matchedThisKwh - matchedLastKwh) / matchedLastKwh) * 100;

  // --- Peaks: top 5 half-hours of the last 30 days ending at newestDay -----
  const peaksFrom = addLocalDays(newestDay, -(PEAKS_WINDOW_DAYS - 1));
  const peakRows = db
    .prepare(
      `SELECT interval_start AS intervalStart, kwh FROM consumption
        WHERE meter_point_id = ? AND interval_start >= ? AND interval_start < ?
        ORDER BY kwh DESC, interval_start LIMIT ?`
    )
    .all(
      meter.id,
      localDayBoundsUtc(peaksFrom).startUtc,
      localDayBoundsUtc(newestDay).endUtc,
      PEAKS_COUNT
    ) as ConsumptionSlice[];

  const peaks = peakRows.map((row) => {
    let costP: number | null = null;
    const agreement: Agreement | null = findAgreementAt(agreements, row.intervalStart);
    if (agreement) {
      const rate = resolveUnitRate(
        unitRatesFor(agreement.tariffCode),
        row.intervalStart,
        config.paymentMethod
      );
      if (rate) costP = halfHourCostP(row.kwh, rate.pIncVat);
    }
    return { intervalStart: row.intervalStart, kwh: row.kwh, costP };
  });

  return {
    fuel,
    heatmap: { from: heatFrom, to: newestDay, days: heatDays, maxKwh },
    baseload: { watts, annualCostP, sampleDays },
    weekCompare: { days: weekDays, thisWeekTotalKwh, lastWeekTotalKwh, deltaPct },
    peaks,
    generatedAt: nowUtcIso(),
  };
}
