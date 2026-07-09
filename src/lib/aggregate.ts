import { getConfig } from "@/lib/config";
import {
  findAgreementAt,
  halfHourCostP,
  loadAgreements,
  loadStandingCharges,
  loadUnitRates,
  resolveStandingCharge,
  resolveUnitRate,
} from "@/lib/costs";
import { getDb } from "@/lib/db";
import {
  addLocalDays,
  localDayBoundsUtc,
  nowUtc,
  nowUtcIso,
  parseLocalDate,
  todayLocal,
  utcIso,
} from "@/lib/time";
import type {
  Agreement,
  CostsResponse,
  DailyCostApiRow,
  Fuel,
  LiveResponse,
  MeterStatus,
  RatesResponse,
  RateSummary,
  Resolution,
  StatusResponse,
  SummaryResponse,
  UnitRateRow,
  UsagePoint,
  UsageResponse,
} from "@/lib/types";

/**
 * Read-side queries for the API routes. Everything reads SQLite via
 * lib/db.ts — never the Octopus API (the 10-minute dashboard refresh must
 * be free). All date-range parameters are Europe/London local dates
 * ("yyyy-MM-dd", inclusive); use lib/time.ts for UTC bounds.
 *
 * Bucketing rules:
 * - "halfhour": raw rows, `t` = UTC interval start.
 * - "day": group by Europe/London calendar day, `t` = "yyyy-MM-dd".
 * - "week": ISO weeks (Monday start), `t` = first local date of the week.
 * - "month": calendar months, `t` = "yyyy-MM-01".
 * - Cost per bucket comes from daily_costs where possible (day and
 *   coarser); half-hour costs are computed on the fly via lib/costs.ts.
 */

/** A telemetry reading older than this is treated as "no live feed". */
const TELEMETRY_FRESH_MINUTES = 30;

interface MeterPointRow {
  id: number;
  fuel: Fuel;
  isExport: number;
  label: string | null;
}

function listMeterPoints(): MeterPointRow[] {
  return getDb()
    .prepare(
      "SELECT id, fuel, is_export AS isExport, label FROM meter_points ORDER BY id"
    )
    .all() as MeterPointRow[];
}

function defaultLabel(fuel: Fuel, isExport: boolean): string {
  if (fuel === "gas") return "Gas";
  return isExport ? "Electricity export" : "Electricity import";
}

function hasRecentTelemetry(): boolean {
  const cutoff = utcIso(nowUtc().minus({ minutes: TELEMETRY_FRESH_MINUTES }));
  return (
    getDb().prepare("SELECT 1 FROM telemetry WHERE read_at >= ? LIMIT 1").get(cutoff) !==
    undefined
  );
}

export function getStatus(): StatusResponse {
  return {
    mode: getConfig().mode,
    meters: getMeterStatuses(),
    telemetryAvailable: hasRecentTelemetry(),
    generatedAt: nowUtcIso(),
  };
}

export function getMeterStatuses(): MeterStatus[] {
  const db = getDb();
  const now = nowUtcIso();
  const latestEndStmt = db.prepare(
    "SELECT MAX(interval_end) AS latest FROM consumption WHERE meter_point_id = ?"
  );
  // SIMPLIFICATION: "complete through" = the latest daily_costs row with a
  // full interval count. An incomplete day sitting *before* that date is not
  // detected; good enough for the freshness indicator, which cares about the
  // tail of the feed.
  const completeStmt = db.prepare(
    `SELECT MAX(local_date) AS d FROM daily_costs
      WHERE meter_point_id = ? AND intervals_present >= intervals_expected`
  );

  return listMeterPoints().map((mp) => {
    const agreements = loadAgreements(mp.id);
    const current = findAgreementAt(agreements, now);
    // Fall back to the newest agreement so a lapsed tariff still displays.
    const newest = agreements.reduce<Agreement | null>(
      (best, a) => (!best || a.validFrom > best.validFrom ? a : best),
      null
    );
    const latest = latestEndStmt.get(mp.id) as { latest: string | null };
    const complete = completeStmt.get(mp.id) as { d: string | null };
    return {
      meterPointId: mp.id,
      fuel: mp.fuel,
      isExport: mp.isExport === 1,
      label: mp.label ?? defaultLabel(mp.fuel, mp.isExport === 1),
      tariffCode: current?.tariffCode ?? newest?.tariffCode ?? null,
      latestIntervalEnd: latest.latest,
      completeThroughLocalDate: complete.d,
    };
  });
}

export function getUsage(
  fuel: Fuel,
  isExport: boolean,
  fromLocalDate: string,
  toLocalDate: string,
  resolution: Resolution
): UsageResponse {
  const db = getDb();
  const response: UsageResponse = {
    fuel,
    isExport,
    resolution,
    from: fromLocalDate,
    to: toLocalDate,
    points: [],
  };
  const meter = db
    .prepare(
      "SELECT id FROM meter_points WHERE fuel = ? AND is_export = ? ORDER BY id LIMIT 1"
    )
    .get(fuel, isExport ? 1 : 0) as { id: number } | undefined;
  if (!meter) return response;

  if (resolution === "halfhour") {
    const { startUtc } = localDayBoundsUtc(fromLocalDate);
    const { endUtc } = localDayBoundsUtc(toLocalDate);
    const rows = db
      .prepare(
        `SELECT interval_start AS intervalStart, kwh FROM consumption
          WHERE meter_point_id = ? AND interval_start >= ? AND interval_start < ?
          ORDER BY interval_start`
      )
      .all(meter.id, startUtc, endUtc) as { intervalStart: string; kwh: number }[];

    const config = getConfig();
    const agreements = loadAgreements(meter.id);
    // One rate-set load per agreement's tariff, not per half-hour row.
    const ratesByTariff = new Map<string, UnitRateRow[]>();
    response.points = rows.map((row) => {
      let costP: number | null = null;
      const agreement = findAgreementAt(agreements, row.intervalStart);
      if (agreement) {
        let rates = ratesByTariff.get(agreement.tariffCode);
        if (!rates) {
          rates = loadUnitRates(agreement.tariffCode);
          ratesByTariff.set(agreement.tariffCode, rates);
        }
        const rate = resolveUnitRate(rates, row.intervalStart, config.paymentMethod);
        if (rate) costP = halfHourCostP(row.kwh, rate.pIncVat);
      }
      return { t: row.intervalStart, kwh: row.kwh, costP };
    });
    return response;
  }

  // Day and coarser read the precomputed daily_costs. UsagePoint.costP is
  // energy-only by contract, hence energy_p rather than total_p; a bucket
  // containing any unpriced consumption reports costP null per the contract
  // ("null when no rate is known") instead of a confidently wrong number.
  const days = db
    .prepare(
      `SELECT local_date AS date, kwh, energy_p AS energyP,
              intervals_present AS present, intervals_priced AS priced
         FROM daily_costs
        WHERE meter_point_id = ? AND local_date >= ? AND local_date <= ?
        ORDER BY local_date`
    )
    .all(meter.id, fromLocalDate, toLocalDate) as {
    date: string;
    kwh: number;
    energyP: number;
    present: number;
    priced: number;
  }[];

  const buckets = new Map<string, UsagePoint>();
  const unpricedKeys = new Set<string>();
  for (const day of days) {
    const key =
      resolution === "day"
        ? day.date
        : resolution === "week"
          ? parseLocalDate(day.date).startOf("week").toISODate()! // luxon weeks are ISO: Monday start
          : `${day.date.slice(0, 7)}-01`;
    if (day.priced < day.present) unpricedKeys.add(key);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.kwh += day.kwh;
      bucket.costP = (bucket.costP ?? 0) + day.energyP;
    } else {
      buckets.set(key, { t: key, kwh: day.kwh, costP: day.energyP });
    }
  }
  for (const key of unpricedKeys) {
    const bucket = buckets.get(key);
    if (bucket) bucket.costP = null;
  }
  response.points = [...buckets.values()]; // input is date-ordered, so buckets are too
  return response;
}

export function getCosts(fromLocalDate: string, toLocalDate: string): CostsResponse {
  const rows = getDb()
    .prepare(
      `SELECT dc.local_date AS date, mp.fuel, mp.is_export AS isExport, dc.kwh,
              dc.energy_p AS energyP, dc.standing_p AS standingP, dc.total_p AS totalP,
              dc.intervals_present AS present, dc.intervals_expected AS expected
         FROM daily_costs dc JOIN meter_points mp ON mp.id = dc.meter_point_id
        WHERE dc.local_date >= ? AND dc.local_date <= ?
        ORDER BY dc.local_date, dc.meter_point_id`
    )
    .all(fromLocalDate, toLocalDate) as {
    date: string;
    fuel: Fuel;
    isExport: number;
    kwh: number;
    energyP: number;
    standingP: number;
    totalP: number;
    present: number;
    expected: number;
  }[];

  let importP = 0;
  let exportP = 0;
  const days: DailyCostApiRow[] = rows.map((r) => {
    if (r.isExport === 1) exportP += r.totalP;
    else importP += r.totalP;
    return {
      date: r.date,
      fuel: r.fuel,
      isExport: r.isExport === 1,
      kwh: r.kwh,
      energyP: r.energyP,
      standingP: r.standingP,
      totalP: r.totalP,
      complete: r.present >= r.expected,
    };
  });

  return {
    from: fromLocalDate,
    to: toLocalDate,
    days,
    totals: { importP, exportP, netP: importP - exportP },
  };
}

export function getSummary(): SummaryResponse {
  const db = getDb();
  const today = todayLocal();
  const yesterday = addLocalDays(today, -1);
  const monthStart = parseLocalDate(today).startOf("month").toISODate()!;

  const yesterdayRows = db
    .prepare(
      `SELECT mp.fuel, mp.is_export AS isExport, dc.kwh, dc.total_p AS totalP,
              dc.intervals_present AS present, dc.intervals_expected AS expected
         FROM daily_costs dc JOIN meter_points mp ON mp.id = dc.meter_point_id
        WHERE dc.local_date = ?`
    )
    .all(yesterday) as {
    fuel: Fuel;
    isExport: number;
    kwh: number;
    totalP: number;
    present: number;
    expected: number;
  }[];

  const tiles: SummaryResponse["yesterday"] = {};
  for (const r of yesterdayRows) {
    // Single meter point per fuel direction assumed (one key per tile).
    const key = r.isExport === 1 ? "export" : r.fuel;
    tiles[key] = { kwh: r.kwh, costP: r.totalP, complete: r.present >= r.expected };
  }

  const mtd = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN mp.is_export = 0 THEN dc.total_p ELSE 0 END), 0) AS importP,
         COALESCE(SUM(CASE WHEN mp.is_export = 1 THEN dc.total_p ELSE 0 END), 0) AS exportP,
         COALESCE(SUM(CASE WHEN mp.is_export = 0 THEN dc.kwh ELSE 0 END), 0) AS importKwh
       FROM daily_costs dc JOIN meter_points mp ON mp.id = dc.meter_point_id
      WHERE dc.local_date >= ? AND dc.local_date <= ?
        AND dc.intervals_present >= dc.intervals_expected`
    )
    .get(monthStart, today) as { importP: number; exportP: number; importKwh: number };

  // "Complete across import meters" = the earliest per-meter complete-through
  // date; null when any import meter has no complete day at all.
  const importMeters = getMeterStatuses().filter((m) => !m.isExport);
  let completeThrough: string | null = null;
  if (
    importMeters.length > 0 &&
    importMeters.every((m) => m.completeThroughLocalDate !== null)
  ) {
    completeThrough = importMeters
      .map((m) => m.completeThroughLocalDate!)
      .sort()[0]!;
  }

  return {
    yesterday: tiles,
    monthToDate: {
      importP: mtd.importP,
      exportP: mtd.exportP,
      netP: mtd.importP - mtd.exportP,
      importKwh: mtd.importKwh,
    },
    completeThroughLocalDate: completeThrough,
    generatedAt: nowUtcIso(),
  };
}

export function getLive(): LiveResponse {
  const db = getDb();
  const latest = db
    .prepare(
      `SELECT read_at AS readAt, demand_w AS demandW FROM telemetry
        ORDER BY read_at DESC LIMIT 1`
    )
    .get() as { readAt: string; demandW: number | null } | undefined;
  const cutoff = utcIso(nowUtc().minus({ minutes: TELEMETRY_FRESH_MINUTES }));
  if (!latest || latest.readAt < cutoff) return { available: false };

  // SINGLE-DEVICE ASSUMPTION: the household has one Home Mini, so summing
  // deltas across all telemetry rows equals summing that device's rows. If a
  // second device ever appears, dedupe per read_at before summing.
  const { startUtc } = localDayBoundsUtc(todayLocal());
  const sums = db
    .prepare(
      `SELECT COALESCE(SUM(consumption_delta_wh), 0) AS wh,
              COALESCE(SUM(cost_delta_p), 0) AS p
         FROM telemetry WHERE read_at >= ?`
    )
    .get(startUtc) as { wh: number; p: number };

  return {
    available: true,
    readAt: latest.readAt,
    ...(latest.demandW !== null ? { demandW: latest.demandW } : {}),
    todayKwh: sums.wh / 1000,
    todayCostP: sums.p,
  };
}

export function getCurrentRates(): RatesResponse {
  const config = getConfig();
  const now = nowUtcIso();

  const rates: RateSummary[] = listMeterPoints().map((mp) => {
    const isExport = mp.isExport === 1;
    const agreement = findAgreementAt(loadAgreements(mp.id), now);
    if (!agreement) {
      return {
        fuel: mp.fuel,
        isExport,
        tariffCode: null,
        unitRatePIncVat: null,
        standingPIncVat: isExport ? 0 : null,
      };
    }
    const unit = resolveUnitRate(
      loadUnitRates(agreement.tariffCode),
      now,
      config.paymentMethod
    );
    let standingPIncVat: number | null = 0;
    if (!isExport) {
      const charge = resolveStandingCharge(
        loadStandingCharges(agreement.tariffCode),
        now,
        config.paymentMethod
      );
      standingPIncVat = charge ? charge.pIncVat : null;
    }
    return {
      fuel: mp.fuel,
      isExport,
      tariffCode: agreement.tariffCode,
      unitRatePIncVat: unit ? unit.pIncVat : null,
      standingPIncVat,
    };
  });

  return { rates, generatedAt: nowUtcIso() };
}
