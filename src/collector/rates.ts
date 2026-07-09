import { recomputeUnpricedDays } from "@/lib/costs";
import { getDb, getState, setState } from "@/lib/db";
import { getDataSource } from "@/lib/octopus/source";
import { nowUtc, parseInstant, utcIso } from "@/lib/time";
import type { Fuel, RateDto, RateType } from "@/lib/types";

/**
 * Tariff data sync: unit rates and standing charges for every agreement
 * (historical ones too — backfilled costs need old tariffs' rates).
 *
 * - Per-agreement watermark ("rates_synced_through:<tariff>|<from>") records
 *   how far rates have actually been FETCHED. Coverage can't be inferred
 *   from stored rows: variable tariffs always hold an open-ended
 *   (valid_to NULL) row, which would make a never-fetched tail look covered
 *   and permanently price it at a stale rate.
 * - Active agreements fetch incrementally from watermark − 7 days (overlap
 *   absorbs revisions) to validTo ?? now + 2 days; without a watermark, the
 *   full agreement window. Keeps steady-state cheap even on half-hourly
 *   tariffs like Agile.
 * - Finished agreements are skipped only once the watermark passes their
 *   end — i.e. rates were fetched at least once after the agreement closed.
 * - rate_type 'standard' for 1R tariffs, 'day'+'night' for E-2R (Economy 7);
 *   payment_method null → '' (cost engine filters at read time).
 * - Ends by re-pricing any daily_costs rows that were computed while rates
 *   were missing (consumption-triggered recomputes can't see late rates).
 */

const INCREMENTAL_OVERLAP_DAYS = 7;

type Db = ReturnType<typeof getDb>;

interface AgreementJob {
  tariffCode: string;
  productCode: string;
  fuel: Fuel;
  validFrom: string;
  validTo: string | null;
}

function rateTypesFor(tariffCode: string): RateType[] {
  return tariffCode.startsWith("E-2R-") ? ["day", "night"] : ["standard"];
}

function upsertUnitRates(db: Db, tariffCode: string, rateType: RateType, rates: RateDto[]): void {
  const stmt = db.prepare(
    `INSERT INTO unit_rates
       (tariff_code, rate_type, payment_method, valid_from, valid_to, p_exc_vat, p_inc_vat)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tariff_code, rate_type, payment_method, valid_from) DO UPDATE SET
       valid_to = excluded.valid_to,
       p_exc_vat = excluded.p_exc_vat,
       p_inc_vat = excluded.p_inc_vat`
  );
  db.transaction(() => {
    for (const r of rates) {
      stmt.run(tariffCode, rateType, r.paymentMethod ?? "", r.validFrom, r.validTo, r.pExcVat, r.pIncVat);
    }
  })();
}

function upsertStandingCharges(db: Db, tariffCode: string, rates: RateDto[]): void {
  const stmt = db.prepare(
    `INSERT INTO standing_charges
       (tariff_code, payment_method, valid_from, valid_to, p_exc_vat, p_inc_vat)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(tariff_code, payment_method, valid_from) DO UPDATE SET
       valid_to = excluded.valid_to,
       p_exc_vat = excluded.p_exc_vat,
       p_inc_vat = excluded.p_inc_vat`
  );
  db.transaction(() => {
    for (const r of rates) {
      stmt.run(tariffCode, r.paymentMethod ?? "", r.validFrom, r.validTo, r.pExcVat, r.pIncVat);
    }
  })();
}

export async function syncRates(): Promise<void> {
  const db = getDb();
  const source = await getDataSource();

  const rows = db
    .prepare(
      `SELECT a.tariff_code AS tariffCode, a.product_code AS productCode,
              m.fuel AS fuel, a.valid_from AS validFrom, a.valid_to AS validTo
       FROM agreements a
       JOIN meter_points m ON m.id = a.meter_point_id
       ORDER BY a.valid_from`
    )
    .all() as AgreementJob[];

  // The same tariff can hang off several meter points — fetch each window once.
  const jobs: AgreementJob[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const key = `${row.tariffCode}|${row.validFrom}|${row.validTo ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    jobs.push(row);
  }

  const nowIso = utcIso(nowUtc());
  const horizon = utcIso(nowUtc().plus({ days: 2 }));
  const errors: string[] = [];

  for (const job of jobs) {
    try {
      const watermarkKey = `rates_synced_through:${job.tariffCode}|${job.validFrom}`;
      const watermark = getState(watermarkKey);
      const toUtc = job.validTo ?? horizon;
      const finished = job.validTo !== null && job.validTo <= nowIso;

      // Fully fetched after the agreement closed — historical rates never change.
      if (finished && watermark && watermark >= job.validTo!) continue;

      const fromUtc = watermark
        ? maxInstant(
            job.validFrom,
            utcIso(parseInstant(watermark).minus({ days: INCREMENTAL_OVERLAP_DAYS }))
          )
        : job.validFrom;

      for (const rateType of rateTypesFor(job.tariffCode)) {
        const rates = await source.getUnitRates(
          job.productCode,
          job.tariffCode,
          job.fuel,
          rateType,
          fromUtc,
          toUtc
        );
        upsertUnitRates(db, job.tariffCode, rateType, rates);
      }
      const standing = await source.getStandingCharges(
        job.productCode,
        job.tariffCode,
        job.fuel,
        fromUtc,
        toUtc
      );
      upsertStandingCharges(db, job.tariffCode, standing);

      setState(watermarkKey, toUtc);
    } catch (err) {
      console.error(`[rates] ${job.tariffCode} (from ${job.validFrom}): sync failed —`, err);
      errors.push(`${job.tariffCode}: ${String(err)}`);
    }
  }

  // Heal days costed while their rates were missing (idempotent, cheap when
  // nothing is unpriced).
  recomputeUnpricedDays();

  if (errors.length > 0) {
    throw new Error(
      `rates sync failed for ${errors.length}/${jobs.length} agreement(s): ${errors.join(" | ")}`
    );
  }
}

function maxInstant(a: string, b: string): string {
  return a > b ? a : b;
}
