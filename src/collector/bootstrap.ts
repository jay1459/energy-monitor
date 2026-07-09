import { getConfig } from "@/lib/config";
import { recomputeRecentDays } from "@/lib/costs";
import { getDb, getState, setState } from "@/lib/db";
import { getDataSource, productCodeFromTariff } from "@/lib/octopus/source";
import type { AccountMeterPointDto, GasUnit } from "@/lib/types";

/**
 * Account sync: discover meter points, serials and agreement history from
 * the data source and upsert into meter_points / meter_serials /
 * agreements. Runs daily (catches tariff switches) and on first boot.
 *
 * - Rows are only ever added or updated, never deleted — history under
 *   old serials/agreements must survive meter exchanges and switches.
 * - product_code is derived from each tariff code via productCodeFromTariff;
 *   an unrecognized code skips that one agreement rather than failing the run.
 * - Gas unit: config.gasUnit 'kwh'/'m3' is authoritative; 'auto' defaults a
 *   fresh meter point to 'm3' and lets the consumption sync infer once it
 *   has enough nonzero readings (decision persisted in sync_state
 *   "gas_unit_decided:<identifier>"). While undecided the consumption sync
 *   may flip the unit and rewrites the kwh column when it does; once
 *   DECIDED the unit never changes.
 * - active_serial is maintained by the consumption sync (the serial that
 *   yields the newest rows); this job never touches it.
 */

type Db = ReturnType<typeof getDb>;

function labelFor(mp: AccountMeterPointDto): string {
  if (mp.fuel === "gas") return "Gas";
  return mp.isExport ? "Solar export" : "Electricity import";
}

/**
 * Reconcile a gas meter point's unit with config. Explicit GAS_UNIT wins
 * (unless data already exists under a different unit — then we refuse and
 * tell the user how to recover); 'auto' defers to the consumption sync's
 * evidence-based inference.
 */
function resolveGasUnit(db: Db, id: number, identifier: string, currentUnit: GasUnit): void {
  const config = getConfig();
  const decidedKey = `gas_unit_decided:${identifier}`;
  const hasData =
    db.prepare("SELECT 1 FROM consumption WHERE meter_point_id = ? LIMIT 1").get(id) !==
    undefined;

  if (config.gasUnit === "kwh" || config.gasUnit === "m3") {
    if (currentUnit !== config.gasUnit) {
      if (hasData) {
        console.error(
          `[bootstrap] GAS_UNIT=${config.gasUnit} conflicts with stored unit '${currentUnit}' ` +
            `for ${identifier} and consumption data already exists — refusing to flip (the kwh ` +
            `column would become inconsistent). Keep GAS_UNIT set and delete the database file ` +
            `to reingest.`
        );
        return;
      }
      db.prepare("UPDATE meter_points SET unit = ? WHERE id = ?").run(config.gasUnit, id);
    }
    setState(decidedKey, config.gasUnit);
    return;
  }

  // auto: the consumption sync owns the inference (it can also safely flip
  // the unit and rewrite kwh while the decision is still undecided). Default
  // a fresh meter point to m3 and leave the decision to it.
  if (getState(decidedKey)) return;
  if (!hasData && currentUnit !== "m3") {
    db.prepare("UPDATE meter_points SET unit = 'm3' WHERE id = ?").run(id);
  }
}

export async function syncAccount(): Promise<void> {
  const source = await getDataSource();
  const account = await source.getAccount();
  const db = getDb();
  const config = getConfig();

  const upsertMeterPoint = db.prepare(
    `INSERT INTO meter_points (fuel, identifier, is_export, unit, label)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(identifier) DO UPDATE SET
       fuel = excluded.fuel,
       is_export = excluded.is_export,
       label = excluded.label`
    // unit deliberately NOT updated on conflict — unit decisions are sticky.
  );
  const selectMeterPoint = db.prepare("SELECT id, unit FROM meter_points WHERE identifier = ?");
  const insertSerial = db.prepare(
    "INSERT OR IGNORE INTO meter_serials (meter_point_id, serial) VALUES (?, ?)"
  );
  const upsertAgreement = db.prepare(
    `INSERT INTO agreements (meter_point_id, tariff_code, product_code, valid_from, valid_to)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(meter_point_id, tariff_code, valid_from) DO UPDATE SET
       product_code = excluded.product_code,
       valid_to = excluded.valid_to
     WHERE agreements.product_code != excluded.product_code
        OR COALESCE(agreements.valid_to, '') != COALESCE(excluded.valid_to, '')`
    // The WHERE guard keeps run().changes meaningful: only real agreement
    // changes trigger the cost recompute below.
  );

  const metersWithAgreementChanges = new Set<number>();
  db.transaction(() => {
    for (const mp of account.meterPoints) {
      const insertUnit: GasUnit =
        mp.fuel === "gas" ? (config.gasUnit === "auto" ? "m3" : config.gasUnit) : "kwh";
      upsertMeterPoint.run(mp.fuel, mp.identifier, mp.isExport ? 1 : 0, insertUnit, labelFor(mp));
      const row = selectMeterPoint.get(mp.identifier) as { id: number; unit: GasUnit };

      for (const serial of mp.serials) {
        insertSerial.run(row.id, serial);
      }

      for (const agreement of mp.agreements) {
        let productCode: string;
        try {
          productCode = productCodeFromTariff(agreement.tariffCode);
        } catch (err) {
          console.warn(
            `[bootstrap] ${mp.identifier}: skipping agreement with unrecognized tariff code ` +
              `${agreement.tariffCode}:`,
            err
          );
          continue;
        }
        const result = upsertAgreement.run(
          row.id,
          agreement.tariffCode,
          productCode,
          agreement.validFrom,
          agreement.validTo
        );
        if (result.changes > 0) metersWithAgreementChanges.add(row.id);
      }
    }
  })();

  // A changed agreement (tariff switch recorded late, valid_to set) can
  // re-price already-costed days — recompute the recent tail.
  for (const meterPointId of metersWithAgreementChanges) {
    recomputeRecentDays(meterPointId, 45);
  }

  for (const mp of account.meterPoints) {
    if (mp.fuel !== "gas") continue;
    const row = selectMeterPoint.get(mp.identifier) as { id: number; unit: GasUnit };
    resolveGasUnit(db, row.id, mp.identifier, row.unit);
  }

  console.log(
    `[bootstrap] account ${account.accountNumber}: ${account.meterPoints.length} meter point(s) synced`
  );
}
