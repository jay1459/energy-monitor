import { getConfig } from "@/lib/config";
import { getDb } from "@/lib/db";
import {
  addLocalDays,
  halfHoursInLocalDay,
  localDayBoundsUtc,
  localDayOf,
  nowUtcIso,
  parseInstant,
  todayLocal,
} from "@/lib/time";
import type { Agreement, RateType, StandingChargeRow, UnitRateRow } from "@/lib/types";

/**
 * Cost engine. Reproduces Octopus billing so computed costs match bills:
 *
 * - Each half-hour's kWh is rounded to the nearest 0.01 kWh using
 *   round-half-to-EVEN before multiplying by the pence rate (official
 *   billing behavior).
 * - Rate join: rate.validFrom <= intervalStart < rate.validTo, with null
 *   validTo treated as +infinity. Callers pass rows already filtered to
 *   the right tariff/rateType/paymentMethod.
 * - Standing charge: one per Europe/London calendar day per import meter
 *   point (exports have none). DST days (46/50 half-hours) still get
 *   exactly one standing charge.
 * - Export meter points: `energyP` in daily_costs holds EARNINGS as a
 *   positive number; the export unit rate has no VAT split.
 * - Agreement history matters: an interval is priced by the agreement
 *   active at that instant, not the current tariff.
 */

/** Round kWh to 0.01 using banker's rounding (round half to even). */
export function roundKwhForBilling(kwh: number): number {
  const scaled = kwh * 100;
  const floor = Math.floor(scaled);
  // Binary floats blur exact halves in both directions (0.135 * 100 ->
  // 13.500000000000002, 2.675 * 100 -> 267.49999999999997), so detect "half"
  // with a tolerance before breaking the tie toward the even hundredth.
  const isHalf = Math.abs(scaled - floor - 0.5) < 1e-9;
  const hundredths = isHalf ? (floor % 2 === 0 ? floor : floor + 1) : Math.round(scaled);
  return hundredths / 100;
}

/**
 * Latest row whose [validFrom, validTo) window covers the instant. Canonical
 * UTC ISO strings sort lexicographically, so plain string comparison is a
 * correct instant ordering. Rows may be in any order; overlaps (which should
 * not survive upstream filtering) resolve to the latest validFrom.
 */
function findCovering<T extends { validFrom: string; validTo: string | null }>(
  rows: T[],
  instantUtc: string
): T | null {
  let best: T | null = null;
  for (const row of rows) {
    if (row.validFrom > instantUtc) continue;
    if (row.validTo !== null && instantUtc >= row.validTo) continue;
    if (!best || row.validFrom > best.validFrom) best = row;
  }
  return best;
}

/**
 * Find the rate row covering an instant. `rates` must be pre-filtered
 * (single tariff, rateType, paymentMethod) and may be in any order.
 * Returns null when no row covers the instant.
 */
export function findRateAt(rates: UnitRateRow[], instantUtc: string): UnitRateRow | null {
  return findCovering(rates, instantUtc);
}

/** Energy cost in pence inc VAT for one half-hour (billing-rounded kWh × rate). */
export function halfHourCostP(kwh: number, ratePIncVat: number): number {
  return roundKwhForBilling(kwh) * ratePIncVat;
}

/** The agreement active at an instant (validFrom <= t < validTo-or-infinity). */
export function findAgreementAt(agreements: Agreement[], instantUtc: string): Agreement | null {
  return findCovering(agreements, instantUtc);
}

/**
 * Two-register (Economy 7) switching window in UTC minutes-of-day:
 * night = [00:30, 07:30), day = the rest. ASSUMPTION: real switch times vary
 * by region and meter (typically GMT-fixed overnight windows); promote this
 * to config if a day/night tariff is ever actually in use.
 */
const NIGHT_START_MIN_UTC = 30;
const NIGHT_END_MIN_UTC = 7 * 60 + 30;

/**
 * Pick the unit-rate row for one tariff covering an instant.
 * `tariffRates` holds every row for a single tariff (all rate types and
 * payment methods). Standard rows win when present; a tariff with ONLY
 * day/night rows is priced by the UTC window above. Within the chosen rate
 * type, prefer the exact payment-method row and fall back to the '' row
 * (the API returned null payment method).
 */
export function resolveUnitRate(
  tariffRates: UnitRateRow[],
  instantUtc: string,
  paymentMethod: string
): UnitRateRow | null {
  let rateType: RateType = "standard";
  if (!tariffRates.some((r) => r.rateType === "standard")) {
    const t = parseInstant(instantUtc);
    const minutes = t.hour * 60 + t.minute;
    rateType =
      minutes >= NIGHT_START_MIN_UTC && minutes < NIGHT_END_MIN_UTC ? "night" : "day";
  }
  const candidates = tariffRates.filter((r) => r.rateType === rateType);
  return (
    findCovering(
      candidates.filter((r) => r.paymentMethod === paymentMethod),
      instantUtc
    ) ??
    findCovering(
      candidates.filter((r) => r.paymentMethod === ""),
      instantUtc
    )
  );
}

/** Standing-charge row covering an instant, with the same payment-method fallback. */
export function resolveStandingCharge(
  charges: StandingChargeRow[],
  instantUtc: string,
  paymentMethod: string
): StandingChargeRow | null {
  return (
    findCovering(
      charges.filter((c) => c.paymentMethod === paymentMethod),
      instantUtc
    ) ??
    findCovering(
      charges.filter((c) => c.paymentMethod === ""),
      instantUtc
    )
  );
}

// --- SQLite loaders (shared with lib/aggregate.ts) --------------------------

export function loadAgreements(meterPointId: number): Agreement[] {
  return getDb()
    .prepare(
      `SELECT meter_point_id AS meterPointId, tariff_code AS tariffCode,
              product_code AS productCode, valid_from AS validFrom, valid_to AS validTo
         FROM agreements WHERE meter_point_id = ?`
    )
    .all(meterPointId) as Agreement[];
}

/** Every unit-rate row for a tariff (all rate types and payment methods). */
export function loadUnitRates(tariffCode: string): UnitRateRow[] {
  return getDb()
    .prepare(
      `SELECT tariff_code AS tariffCode, rate_type AS rateType,
              payment_method AS paymentMethod, valid_from AS validFrom,
              valid_to AS validTo, p_exc_vat AS pExcVat, p_inc_vat AS pIncVat
         FROM unit_rates WHERE tariff_code = ?`
    )
    .all(tariffCode) as UnitRateRow[];
}

export function loadStandingCharges(tariffCode: string): StandingChargeRow[] {
  return getDb()
    .prepare(
      `SELECT tariff_code AS tariffCode, payment_method AS paymentMethod,
              valid_from AS validFrom, valid_to AS validTo,
              p_exc_vat AS pExcVat, p_inc_vat AS pIncVat
         FROM standing_charges WHERE tariff_code = ?`
    )
    .all(tariffCode) as StandingChargeRow[];
}

/**
 * Recompute and upsert daily_costs rows for the given meter point and
 * Europe/London dates. Reads consumption, agreements, unit_rates and
 * standing_charges from SQLite (lib/db.ts); resolves the agreement per
 * interval; filters rates by the configured payment method, accepting ''
 * (null from API) rows when no payment-specific row exists.
 *
 * A day is complete when intervals_present === intervals_expected
 * (46/48/50 — use halfHoursInLocalDay from lib/time.ts).
 */
export function computeDailyCosts(meterPointId: number, localDates: string[]): void {
  if (localDates.length === 0) return;
  const db = getDb();
  const config = getConfig();

  const meter = db
    .prepare("SELECT is_export AS isExport FROM meter_points WHERE id = ?")
    .get(meterPointId) as { isExport: number } | undefined;
  if (!meter) throw new Error(`unknown meter point id: ${meterPointId}`);
  const isExport = meter.isExport === 1;

  const agreements = loadAgreements(meterPointId);

  // One rate-set load per tariff for the whole batch, not per interval.
  const ratesByTariff = new Map<string, UnitRateRow[]>();
  const chargesByTariff = new Map<string, StandingChargeRow[]>();
  const unitRatesFor = (tariffCode: string): UnitRateRow[] => {
    let rows = ratesByTariff.get(tariffCode);
    if (!rows) {
      rows = loadUnitRates(tariffCode);
      ratesByTariff.set(tariffCode, rows);
    }
    return rows;
  };
  const standingChargesFor = (tariffCode: string): StandingChargeRow[] => {
    let rows = chargesByTariff.get(tariffCode);
    if (!rows) {
      rows = loadStandingCharges(tariffCode);
      chargesByTariff.set(tariffCode, rows);
    }
    return rows;
  };

  const selectDay = db.prepare(
    `SELECT interval_start AS intervalStart, kwh FROM consumption
      WHERE meter_point_id = ? AND interval_start >= ? AND interval_start < ?
      ORDER BY interval_start`
  );
  const upsert = db.prepare(
    `INSERT INTO daily_costs
       (meter_point_id, local_date, kwh, intervals_present, intervals_expected,
        intervals_priced, energy_p, standing_p, total_p, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(meter_point_id, local_date) DO UPDATE SET
       kwh = excluded.kwh,
       intervals_present = excluded.intervals_present,
       intervals_expected = excluded.intervals_expected,
       intervals_priced = excluded.intervals_priced,
       energy_p = excluded.energy_p,
       standing_p = excluded.standing_p,
       total_p = excluded.total_p,
       computed_at = excluded.computed_at`
  );

  const computedAt = nowUtcIso();
  db.transaction(() => {
    for (const date of localDates) {
      const { startUtc, endUtc } = localDayBoundsUtc(date);
      const intervals = selectDay.all(meterPointId, startUtc, endUtc) as {
        intervalStart: string;
        kwh: number;
      }[];

      let kwhTotal = 0;
      let energyP = 0;
      let priced = 0;
      for (const hh of intervals) {
        kwhTotal += hh.kwh;
        const agreement = findAgreementAt(agreements, hh.intervalStart);
        if (!agreement) continue; // no agreement covers it: kWh counted, unpriceable
        const rate = resolveUnitRate(
          unitRatesFor(agreement.tariffCode),
          hh.intervalStart,
          config.paymentMethod
        );
        if (!rate) continue; // rates not synced yet: kWh counted, cost omitted
        energyP += halfHourCostP(hh.kwh, rate.pIncVat);
        priced += 1;
      }

      // Standing charge accrues once per Europe/London calendar day (billed
      // regardless of how many half-hours have landed yet); exports have none.
      let standingP = 0;
      if (!isExport) {
        const agreement = findAgreementAt(agreements, startUtc);
        if (agreement) {
          const charge = resolveStandingCharge(
            standingChargesFor(agreement.tariffCode),
            startUtc,
            config.paymentMethod
          );
          if (charge) standingP = charge.pIncVat;
        }
      }

      upsert.run(
        meterPointId,
        date,
        kwhTotal,
        intervals.length,
        halfHoursInLocalDay(date),
        priced,
        energyP,
        standingP,
        energyP + standingP,
        computedAt
      );
    }
  })();
}

/**
 * Convenience: recompute every local day touched by the given interval
 * starts (used by the collector after an upsert batch). Mapping each
 * interval START's local day is sufficient — a day's last half-hour may
 * END past local midnight, but starts alone define day membership.
 */
export function recomputeDaysForIntervals(
  meterPointId: number,
  intervalStartsUtc: string[]
): void {
  if (intervalStartsUtc.length === 0) return;
  const dates = [...new Set(intervalStartsUtc.map(localDayOf))].sort();
  computeDailyCosts(meterPointId, dates);
}

/**
 * Re-price days that were computed while rates (or agreements) were missing —
 * intervals_priced < intervals_present marks them. Called after a rates sync
 * lands new rows; consumption-triggered recomputes can't see late rates.
 */
export function recomputeUnpricedDays(): void {
  const rows = getDb()
    .prepare(
      `SELECT meter_point_id AS meterPointId, local_date AS localDate
         FROM daily_costs WHERE intervals_priced < intervals_present`
    )
    .all() as { meterPointId: number; localDate: string }[];
  if (rows.length === 0) return;

  const byMeter = new Map<number, string[]>();
  for (const row of rows) {
    const dates = byMeter.get(row.meterPointId) ?? [];
    dates.push(row.localDate);
    byMeter.set(row.meterPointId, dates);
  }
  for (const [meterPointId, dates] of byMeter) {
    computeDailyCosts(meterPointId, dates);
  }
  console.log(`[costs] re-priced ${rows.length} day(s) that had missing rates`);
}

/**
 * Recompute the recent days that already have cost rows for a meter point —
 * used when its agreement history changes (a tariff switch recorded late
 * re-prices the tail under the correct agreement).
 */
export function recomputeRecentDays(meterPointId: number, days: number): void {
  const dates = (
    getDb()
      .prepare(
        `SELECT local_date AS d FROM daily_costs
          WHERE meter_point_id = ? AND local_date >= ?`
      )
      .all(meterPointId, addLocalDays(todayLocal(), -days)) as { d: string }[]
  ).map((r) => r.d);
  computeDailyCosts(meterPointId, dates);
}
