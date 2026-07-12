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
import { getDb, getState } from "@/lib/db";
import { localDayBoundsUtc, localDaySpan, nowUtcIso } from "@/lib/time";
import type { Agreement, CompareResponse, Fuel, TariffQuote } from "@/lib/types";

/**
 * Tariff comparison for /api/compare: price the household's ACTUAL stored
 * half-hourly consumption under candidate Octopus tariffs (whose rates the
 * compare collector job keeps in unit_rates/standing_charges under the
 * candidate tariff codes) and set it against what the current tariff costs.
 *
 * Rules:
 * - Range is local dates [fromLocalDate, toLocalDate], inclusive; only
 *   IMPORT meter points participate (export earnings are tariff-specific
 *   and out of scope).
 * - Current-tariff rows come from daily_costs (energy_p/standing_p sums) so
 *   they exactly match the Costs page; isCurrent = true.
 * - Candidate rows: for each consumption half-hour, roundKwhForBilling(kwh)
 *   × the candidate rate covering that instant (lib/costs.ts resolveUnitRate
 *   with the configured payment method, '' fallback), plus the candidate
 *   standing charge per local day in range. Rates load once per tariff.
 * - coveragePct = priced intervals / total intervals × 100 (Agile rates
 *   exist only where the sync has reached; a low figure warns the UI).
 * - Candidate metadata comes from sync_state "compare_candidates" (JSON
 *   written by src/collector/compare.ts): [{ productCode, displayName,
 *   fuel, tariffCode }]. candidatesSyncedAt from sync_state
 *   "compare_candidates_synced_at" (null before first sync).
 * - A candidate that IS the current tariff for its fuel is skipped — the
 *   contract is one row per (tariff, fuel), and the current row already
 *   reflects the actual bills.
 * - quotes sorted cheapest-first within each fuel, electricity before gas.
 */

interface CandidateMeta {
  productCode: string;
  displayName: string;
  fuel: Fuel;
  tariffCode: string;
}

function isCandidateMeta(x: unknown): x is CandidateMeta {
  if (typeof x !== "object" || x === null) return false;
  const c = x as Record<string, unknown>;
  return (
    typeof c.productCode === "string" &&
    typeof c.displayName === "string" &&
    (c.fuel === "electricity" || c.fuel === "gas") &&
    typeof c.tariffCode === "string"
  );
}

/**
 * Friendly names for common Octopus product families. The agreements API
 * never returns names, so the current tariff's row falls back to a static
 * family map (candidates get real names from catalogue discovery).
 */
function productDisplayName(productCode: string): string {
  if (productCode.startsWith("VAR-")) return "Flexible Octopus";
  if (productCode.startsWith("AGILE-")) return "Agile Octopus";
  if (productCode.startsWith("SILVER-")) return "Octopus Tracker";
  if (productCode.includes("FIX")) return `Fixed Octopus (${productCode})`;
  return productCode;
}

/** Parsed sync_state "compare_candidates"; empty before the first sync (or on garbage). */
function loadCandidates(): CandidateMeta[] {
  const raw = getState("compare_candidates");
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isCandidateMeta) : [];
  } catch {
    return [];
  }
}

/**
 * Newest local date with complete data across every import meter (the
 * /api/compare default `to`), or null before any complete day exists.
 */
export function newestCompleteImportDay(): string | null {
  const db = getDb();
  const meters = db
    .prepare("SELECT id FROM meter_points WHERE is_export = 0")
    .all() as { id: number }[];
  if (meters.length === 0) return null;
  const stmt = db.prepare(
    `SELECT MAX(local_date) AS d FROM daily_costs
      WHERE meter_point_id = ? AND intervals_present >= intervals_expected`
  );
  let earliest: string | null = null;
  for (const m of meters) {
    const { d } = stmt.get(m.id) as { d: string | null };
    if (d === null) return null;
    if (earliest === null || d < earliest) earliest = d;
  }
  return earliest;
}

export function getComparison(fromLocalDate: string, toLocalDate: string): CompareResponse {
  const db = getDb();
  const config = getConfig();
  const now = nowUtcIso();
  const { startUtc: rangeStartUtc } = localDayBoundsUtc(fromLocalDate);
  const { endUtc: rangeEndUtc } = localDayBoundsUtc(toLocalDate);

  // One import meter per fuel assumed (first by id, matching getUsage).
  const meterByFuel = new Map<Fuel, number>();
  for (const m of db
    .prepare("SELECT id, fuel FROM meter_points WHERE is_export = 0 ORDER BY id")
    .all() as { id: number; fuel: Fuel }[]) {
    if (!meterByFuel.has(m.fuel)) meterByFuel.set(m.fuel, m.id);
  }

  const quotes: TariffQuote[] = [];
  const currentTariffByFuel = new Map<Fuel, string>();

  // --- Current tariff: daily_costs sums, so the row matches the Costs page.
  const sumStmt = db.prepare(
    `SELECT COALESCE(SUM(energy_p), 0) AS energyP,
            COALESCE(SUM(standing_p), 0) AS standingP,
            COALESCE(SUM(total_p), 0) AS totalP,
            COALESCE(SUM(intervals_present), 0) AS present,
            COALESCE(SUM(intervals_priced), 0) AS priced
       FROM daily_costs
      WHERE meter_point_id = ? AND local_date >= ? AND local_date <= ?`
  );
  for (const [fuel, meterId] of meterByFuel) {
    const agreements = loadAgreements(meterId);
    // Fall back to the newest agreement so a lapsed tariff still compares.
    const current =
      findAgreementAt(agreements, now) ??
      agreements.reduce<Agreement | null>(
        (best, a) => (!best || a.validFrom > best.validFrom ? a : best),
        null
      );
    if (!current) continue; // no agreement recorded — nothing to label the row with
    currentTariffByFuel.set(fuel, current.tariffCode);
    const sums = sumStmt.get(meterId, fromLocalDate, toLocalDate) as {
      energyP: number;
      standingP: number;
      totalP: number;
      present: number;
      priced: number;
    };
    quotes.push({
      tariffCode: current.tariffCode,
      productCode: current.productCode,
      displayName: productDisplayName(current.productCode),
      fuel,
      isCurrent: true,
      energyP: sums.energyP,
      standingP: sums.standingP,
      totalP: sums.totalP,
      coveragePct: sums.present > 0 ? (sums.priced / sums.present) * 100 : 0,
    });
  }

  // --- Candidates: re-price the stored half-hours under each candidate.
  const consumptionStmt = db.prepare(
    `SELECT interval_start AS intervalStart, kwh FROM consumption
      WHERE meter_point_id = ? AND interval_start >= ? AND interval_start < ?`
  );
  const billedDatesStmt = db.prepare(
    `SELECT local_date AS d FROM daily_costs
      WHERE meter_point_id = ? AND local_date >= ? AND local_date <= ?
      ORDER BY local_date`
  );
  for (const candidate of loadCandidates()) {
    const meterId = meterByFuel.get(candidate.fuel);
    if (meterId === undefined) continue; // fuel not on this account
    if (currentTariffByFuel.get(candidate.fuel) === candidate.tariffCode) continue;

    const halfHours = consumptionStmt.all(meterId, rangeStartUtc, rangeEndUtc) as {
      intervalStart: string;
      kwh: number;
    }[];
    const rates = loadUnitRates(candidate.tariffCode);
    let energyP = 0;
    let priced = 0;
    for (const hh of halfHours) {
      const rate = resolveUnitRate(rates, hh.intervalStart, config.paymentMethod);
      if (!rate) continue;
      energyP += halfHourCostP(hh.kwh, rate.pIncVat);
      priced += 1;
    }

    // Standing charge accrues only over the local days the CURRENT tariff
    // was billed for (days with a daily_costs row) — the current row's sums
    // can't include days whose data hasn't landed, and charging candidates
    // for those days (yesterday, comms gaps) would skew every comparison
    // against the alternatives.
    const billedDates = (
      billedDatesStmt.all(meterId, fromLocalDate, toLocalDate) as { d: string }[]
    ).map((r) => r.d);
    const charges = loadStandingCharges(candidate.tariffCode);
    let standingP = 0;
    for (const date of billedDates) {
      const charge = resolveStandingCharge(
        charges,
        localDayBoundsUtc(date).startUtc,
        config.paymentMethod
      );
      if (charge) standingP += charge.pIncVat;
    }

    quotes.push({
      tariffCode: candidate.tariffCode,
      productCode: candidate.productCode,
      displayName: candidate.displayName,
      fuel: candidate.fuel,
      isCurrent: false,
      energyP,
      standingP,
      totalP: energyP + standingP,
      coveragePct: halfHours.length > 0 ? (priced / halfHours.length) * 100 : 0,
    });
  }

  quotes.sort((a, b) => {
    if (a.fuel !== b.fuel) return a.fuel === "electricity" ? -1 : 1;
    return a.totalP - b.totalP;
  });

  return {
    from: fromLocalDate,
    to: toLocalDate,
    dayCount: localDaySpan(fromLocalDate, toLocalDate),
    quotes,
    candidatesSyncedAt: getState("compare_candidates_synced_at"),
    generatedAt: nowUtcIso(),
  };
}
