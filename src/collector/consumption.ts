import { getConfig } from "@/lib/config";
import { computeDailyCosts, recomputeDaysForIntervals } from "@/lib/costs";
import { deleteState, getDb, getState, setState } from "@/lib/db";
import { getDataSource, type EnergyDataSource } from "@/lib/octopus/source";
import {
  addLocalDays,
  localDayBoundsUtc,
  nowUtc,
  nowUtcIso,
  parseInstant,
  todayLocal,
  utcIso,
} from "@/lib/time";
import type { ConsumptionReadingDto, Fuel, GasUnit } from "@/lib/types";

/**
 * Half-hourly consumption sync. The API is day-late and revises history,
 * so this is a cursor + trailing-window idempotent upsert:
 *
 * - Cursor per meter point in sync_state ("consumption_cursor:<id>") =
 *   latest interval_end ingested. Canonical UTC strings compare
 *   lexicographically, so plain string min/max works.
 * - Each run fetches from min(cursor, now - TRAILING_DAYS) to now; the
 *   trailing window (14 days) picks up late arrivals and revisions.
 * - Backfill: no cursor -> walk backwards in 365-day windows across ALL
 *   serials (pre-exchange history lives under old serials; the series are
 *   unioned) until a window is empty on every serial, capped at ~3 years.
 *   Each window is upserted as it lands, so a mid-backfill failure keeps
 *   its progress; "backfill_pending:<id>" records where to resume.
 * - Meter exchange: when the cursor is stale and the active serial yields
 *   nothing NEWER than the cursor (old rows in the trailing window don't
 *   count), the other serials are tried.
 * - Weekly deep re-scan: incomplete local days older than the trailing
 *   window (up to 90 days back) are re-fetched — Octopus occasionally
 *   publishes reads weeks late, which the cursor+trailing window would
 *   otherwise never see.
 * - Upsert keyed on (meter_point_id, interval_start). An existing row is
 *   only touched when the value actually changed: revised_at = now,
 *   fetched_at kept from the original ingest.
 * - Gas: value_raw is stored as returned; kwh = m³ × 1.02264 × CV ÷ 3.6
 *   when the meter point unit is 'm3' (CV from config), else kwh = raw.
 *   GAS_UNIT=auto infers the unit once >= 48 nonzero readings exist; while
 *   undecided a flip rewrites the kwh column and re-costs affected days.
 * - After upserting, recomputeDaysForIntervals (lib/costs.ts) runs for
 *   inserted/revised intervals only.
 * - Empty responses are a data-availability condition, not an error; a
 *   failure on one meter point never stops the others (aggregated and
 *   rethrown at the end so the scheduler records the failure).
 */

const TRAILING_DAYS = 14;
const BACKFILL_WINDOW_DAYS = 365;
/** ~3 years of history — enough for the dashboard, polite to the API. */
const MAX_BACKFILL_WINDOWS = 3;
/** Only hunt across inactive serials once the cursor is this stale. */
const SERIAL_FALLBACK_CURSOR_AGE_DAYS = 3;
/** Volume correction factor for metric gas meters (m³ → kWh). */
const M3_VOLUME_CORRECTION = 1.02264;
/** Nonzero readings required before the gas-unit inference commits. */
const MIN_GAS_UNIT_SAMPLE = 48;
const DEEP_RESCAN_INTERVAL_DAYS = 7;
const DEEP_RESCAN_LOOKBACK_DAYS = 90;
const DEEP_RESCAN_MAX_DAYS = 20;

type Db = ReturnType<typeof getDb>;

interface MeterPointRow {
  id: number;
  fuel: Fuel;
  identifier: string;
  unit: GasUnit;
  active_serial: string | null;
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/**
 * Decide a gas meter point's unit from the evidence so far (stored rows +
 * the incoming batch) when GAS_UNIT=auto. Metric (SMETS2) m³ half-hours sit
 * well below 0.9; SMETS1 kWh heating half-hours routinely exceed it — >20%
 * of nonzero readings above 0.9 means kWh. The decision only commits once
 * MIN_GAS_UNIT_SAMPLE nonzero readings exist (an all-zero vacant-property
 * batch must not lock in a guess); while undecided, a flip rewrites the kwh
 * column and re-costs the affected days, so deferring is safe. Once decided
 * (sync_state "gas_unit_decided:<identifier>") the unit never changes.
 */
function refineGasUnit(db: Db, mp: MeterPointRow, readings: ConsumptionReadingDto[]): GasUnit {
  if (mp.fuel !== "gas") return mp.unit;
  const config = getConfig();
  if (config.gasUnit !== "auto") return mp.unit;

  const decidedKey = `gas_unit_decided:${mp.identifier}`;
  if (getState(decidedKey)) return mp.unit;

  const stored = (
    db
      .prepare(
        "SELECT value_raw AS v FROM consumption WHERE meter_point_id = ? AND value_raw > 0 LIMIT 500"
      )
      .all(mp.id) as { v: number }[]
  ).map((r) => r.v);
  const sample = stored.concat(readings.map((r) => r.value).filter((v) => v > 0));
  if (sample.length < MIN_GAS_UNIT_SAMPLE) {
    return mp.unit; // not enough evidence yet — stay provisional, decide later
  }

  const over = sample.filter((v) => v > 0.9).length;
  const unit: GasUnit = over / sample.length > 0.2 ? "kwh" : "m3";

  if (unit !== mp.unit) {
    // Rows ingested under the provisional unit get their kwh rewritten in
    // place, then every already-costed day is re-priced.
    const factor = unit === "m3" ? (M3_VOLUME_CORRECTION * config.gasCalorificValue) / 3.6 : 1;
    db.transaction(() => {
      db.prepare("UPDATE meter_points SET unit = ? WHERE id = ?").run(unit, mp.id);
      db.prepare(
        "UPDATE consumption SET kwh = ROUND(value_raw * ?, 6) WHERE meter_point_id = ?"
      ).run(factor, mp.id);
    })();
    const dates = (
      db
        .prepare("SELECT local_date AS d FROM daily_costs WHERE meter_point_id = ?")
        .all(mp.id) as { d: string }[]
    ).map((r) => r.d);
    computeDailyCosts(mp.id, dates);
  }

  setState(decidedKey, unit);
  console.log(
    `[consumption] ${mp.identifier}: gas unit inferred as '${unit}' from ${sample.length} ` +
      `nonzero half-hours — set GAS_UNIT to override before ingest`
  );
  return unit;
}

async function syncMeterPoint(db: Db, source: EnergyDataSource, mp: MeterPointRow): Promise<void> {
  const serials = (
    db
      .prepare("SELECT serial FROM meter_serials WHERE meter_point_id = ? ORDER BY serial")
      .all(mp.id) as { serial: string }[]
  ).map((r) => r.serial);
  if (serials.length === 0) {
    console.warn(`[consumption] ${mp.identifier}: no serials known yet — account sync runs first`);
    return;
  }

  const cursorKey = `consumption_cursor:${mp.id}`;
  const pendingKey = `backfill_pending:${mp.id}`;
  let cursor = getState(cursorKey);
  const now = nowUtc();
  const nowIso = utcIso(now);

  const newestEndBySerial = new Map<string, string>();

  /** Fetch [fromUtc, toUtc) for the given serials, unioned by interval start. */
  const fetchWindow = async (
    serialList: string[],
    fromUtc: string,
    toUtc: string
  ): Promise<Map<string, ConsumptionReadingDto>> => {
    const readings = new Map<string, ConsumptionReadingDto>();
    for (const serial of serialList) {
      const rows = await source.getConsumption(mp.fuel, mp.identifier, serial, fromUtc, toUtc);
      for (const row of rows) {
        readings.set(row.intervalStart, row);
        const prev = newestEndBySerial.get(serial);
        if (!prev || row.intervalEnd > prev) newestEndBySerial.set(serial, row.intervalEnd);
      }
    }
    return readings;
  };

  const upsert = db.prepare(
    `INSERT INTO consumption
       (meter_point_id, interval_start, interval_end, value_raw, kwh, fetched_at, revised_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT(meter_point_id, interval_start) DO UPDATE SET
       interval_end = excluded.interval_end,
       value_raw = excluded.value_raw,
       kwh = excluded.kwh,
       revised_at = excluded.fetched_at
     WHERE consumption.value_raw != excluded.value_raw OR consumption.kwh != excluded.kwh`
  );

  let totalFetched = 0;
  let totalChanged = 0;

  /** Refine gas unit, upsert one batch, advance the cursor, re-cost changes. */
  const processBatch = (rows: ConsumptionReadingDto[]): void => {
    if (rows.length === 0) return;
    totalFetched += rows.length;
    mp.unit = refineGasUnit(db, mp, rows);
    const cv = getConfig().gasCalorificValue;
    const toKwh = (value: number): number =>
      mp.unit === "m3" ? round6((value * M3_VOLUME_CORRECTION * cv) / 3.6) : round6(value);

    const fetchedAt = nowUtcIso();
    const changed: string[] = [];
    let maxEnd = cursor ?? "";
    db.transaction(() => {
      for (const row of rows) {
        const result = upsert.run(
          mp.id,
          row.intervalStart,
          row.intervalEnd,
          row.value,
          toKwh(row.value),
          fetchedAt
        );
        if (result.changes > 0) changed.push(row.intervalStart);
        if (row.intervalEnd > maxEnd) maxEnd = row.intervalEnd;
      }
      if (maxEnd && maxEnd !== cursor) {
        setState(cursorKey, maxEnd);
        cursor = maxEnd;
      }
    })();

    if (changed.length > 0) {
      totalChanged += changed.length;
      recomputeDaysForIntervals(mp.id, changed);
    }
  };

  /**
   * Walk backfill windows newest-first from startWindow, persisting each
   * window as it lands. A failed window records itself in backfill_pending
   * so a later run resumes there instead of restarting the whole sweep
   * (window boundaries are re-anchored to "now" each run; the overlap is
   * absorbed by the idempotent upsert).
   */
  const backfillWindows = async (startWindow: number): Promise<void> => {
    for (let window = startWindow; window < MAX_BACKFILL_WINDOWS; window++) {
      const toUtc = utcIso(now.minus({ days: BACKFILL_WINDOW_DAYS * window }));
      const fromUtc = utcIso(now.minus({ days: BACKFILL_WINDOW_DAYS * (window + 1) }));
      let readings: Map<string, ConsumptionReadingDto>;
      try {
        readings = await fetchWindow(serials, fromUtc, toUtc);
      } catch (err) {
        setState(pendingKey, String(window));
        throw err;
      }
      if (readings.size === 0) break; // beyond available history
      processBatch([...readings.values()]);
    }
    deleteState(pendingKey);
  };

  if (!cursor) {
    await backfillWindows(0);
  } else {
    const floor = utcIso(now.minus({ days: TRAILING_DAYS }));
    const fromUtc = cursor < floor ? cursor : floor;
    const primary =
      mp.active_serial && serials.includes(mp.active_serial) ? [mp.active_serial] : serials;
    const readings = await fetchWindow(primary, fromUtc, nowIso);

    // Newest interval the primary serial(s) produced. Old rows sitting in
    // the trailing window don't count as progress — only data newer than
    // the cursor proves the serial is still alive.
    let maxPrimaryEnd = "";
    for (const serial of primary) {
      const end = newestEndBySerial.get(serial);
      if (end && end > maxPrimaryEnd) maxPrimaryEnd = end;
    }
    const cursorStale = cursor < utcIso(now.minus({ days: SERIAL_FALLBACK_CURSOR_AGE_DAYS }));
    if (cursorStale && maxPrimaryEnd <= cursor && primary.length < serials.length) {
      // Nothing newer for days — likely a meter exchange; try the others.
      const others = serials.filter((s) => !primary.includes(s));
      for (const [start, row] of await fetchWindow(others, fromUtc, nowIso)) {
        readings.set(start, row);
      }
    }
    processBatch([...readings.values()]);

    // Resume an interrupted deep backfill.
    const pending = getState(pendingKey);
    if (pending !== null) {
      await backfillWindows(Number(pending));
    }

    await deepRescan(db, mp, fetchWindow, processBatch, nowIso);
  }

  // Keep active_serial pointing at whichever serial yields the newest data.
  let bestSerial: string | null = null;
  let bestEnd = "";
  for (const [serial, end] of newestEndBySerial) {
    if (end > bestEnd) {
      bestEnd = end;
      bestSerial = serial;
    }
  }
  if (bestSerial && bestSerial !== mp.active_serial) {
    db.prepare("UPDATE meter_points SET active_serial = ? WHERE id = ?").run(bestSerial, mp.id);
  }

  if (totalFetched === 0) {
    console.log(`[consumption] ${mp.fuel} ${mp.identifier}: no new data (day-late API — normal)`);
  } else {
    console.log(
      `[consumption] ${mp.fuel} ${mp.identifier}: ${totalFetched} fetched, ` +
        `${totalChanged} inserted/revised, cursor ${cursor ?? "(unset)"}`
    );
  }
}

/**
 * Weekly: re-fetch incomplete local days that have aged out of the trailing
 * window (Octopus occasionally publishes reads weeks late). Bounded to the
 * last 90 days and 20 days per pass; days that never complete (meter comms
 * gaps) cost at most that much politeness per week.
 */
async function deepRescan(
  db: Db,
  mp: MeterPointRow,
  fetchWindow: (
    serials: string[],
    fromUtc: string,
    toUtc: string
  ) => Promise<Map<string, ConsumptionReadingDto>>,
  processBatch: (rows: ConsumptionReadingDto[]) => void,
  nowIso: string
): Promise<void> {
  const rescanKey = `deep_rescan_at:${mp.id}`;
  const last = getState(rescanKey);
  if (last && parseInstant(last) > nowUtc().minus({ days: DEEP_RESCAN_INTERVAL_DAYS })) {
    return;
  }

  const serials = (
    db
      .prepare("SELECT serial FROM meter_serials WHERE meter_point_id = ?")
      .all(mp.id) as { serial: string }[]
  ).map((r) => r.serial);
  const today = todayLocal();
  const gaps = (
    db
      .prepare(
        `SELECT local_date AS d FROM daily_costs
          WHERE meter_point_id = ? AND intervals_present < intervals_expected
            AND local_date < ? AND local_date >= ?
          ORDER BY local_date DESC LIMIT ?`
      )
      .all(
        mp.id,
        addLocalDays(today, -TRAILING_DAYS),
        addLocalDays(today, -DEEP_RESCAN_LOOKBACK_DAYS),
        DEEP_RESCAN_MAX_DAYS
      ) as { d: string }[]
  ).map((r) => r.d);

  for (const date of gaps) {
    const { startUtc, endUtc } = localDayBoundsUtc(date);
    const readings = await fetchWindow(serials, startUtc, endUtc);
    if (readings.size > 0) processBatch([...readings.values()]);
  }
  if (gaps.length > 0) {
    console.log(`[consumption] ${mp.identifier}: deep re-scan checked ${gaps.length} gap day(s)`);
  }
  setState(rescanKey, nowIso);
}

export async function syncConsumption(): Promise<void> {
  const db = getDb();
  const source = await getDataSource();
  const meterPoints = db
    .prepare("SELECT id, fuel, identifier, unit, active_serial FROM meter_points")
    .all() as MeterPointRow[];

  const errors: string[] = [];
  for (const mp of meterPoints) {
    try {
      await syncMeterPoint(db, source, mp);
    } catch (err) {
      console.error(`[consumption] ${mp.fuel} ${mp.identifier}: sync failed —`, err);
      errors.push(`${mp.fuel} ${mp.identifier}: ${String(err)}`);
    }
  }
  if (errors.length > 0) {
    throw new Error(
      `consumption sync failed for ${errors.length}/${meterPoints.length} meter point(s): ` +
        errors.join(" | ")
    );
  }
}
