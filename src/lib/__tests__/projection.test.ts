import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterAll } from "vitest";

// Env MUST be set before any app module is imported.
const dbPath = path.join(os.tmpdir(), `energy-projection-test-${randomUUID()}.db`);
process.env.ENERGY_DB_PATH = dbPath;
process.env.ENERGY_MOCK = "1";

const { getSummary } = await import("@/lib/aggregate");
const { getDb } = await import("@/lib/db");
const time = await import("@/lib/time");

const actualDbPath = dbPath.replace(/\.db$/, ".mock.db");

afterAll(() => {
  try {
    getDb().close();
  } catch {
    // best effort
  }
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(actualDbPath + suffix, { force: true });
  }
});

/**
 * Review regression: the month-end projection must treat a date as billed
 * only when EVERY meter has a COMPLETE daily_costs row for it. A date where
 * gas lags (row missing) or is partial (row incomplete) must be wholly
 * projected — mixing per-row actuals with per-date projection double-counts
 * or drops a fuel.
 */
describe("getSummary month-end projection", () => {
  it("excludes dates with a missing or incomplete meter row from the billed term", () => {
    const db = getDb();
    db.prepare(
      "INSERT INTO meter_points (id, fuel, identifier, is_export, unit) VALUES (1, 'electricity', '1200000000010', 0, 'kwh')"
    ).run();
    db.prepare(
      "INSERT INTO meter_points (id, fuel, identifier, is_export, unit) VALUES (2, 'gas', '3900000010', 0, 'm3')"
    ).run();

    const insert = db.prepare(
      `INSERT INTO daily_costs
         (meter_point_id, local_date, kwh, intervals_present, intervals_expected,
          intervals_priced, energy_p, standing_p, total_p, computed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const today = time.todayLocal();
    const day = (offset: number) => time.addLocalDays(today, offset);
    const now = time.nowUtcIso();

    // D-13 .. D-3: eleven dates fully complete on both meters, net 400 p/day
    // (elec 250 + gas 150).
    for (let offset = -13; offset <= -3; offset++) {
      insert.run(1, day(offset), 10, 48, 48, 48, 200, 50, 250, now);
      insert.run(2, day(offset), 5, 48, 48, 48, 120, 30, 150, now);
    }
    // D-2: elec complete, gas row MISSING (day-late gas — the routine case).
    insert.run(1, day(-2), 10, 48, 48, 48, 200, 50, 250, now);
    // D-1: elec complete, gas row INCOMPLETE (revision pending).
    insert.run(1, day(-1), 10, 48, 48, 48, 200, 50, 250, now);
    insert.run(2, day(-1), 2, 24, 48, 24, 60, 30, 90, now);

    const { projection } = getSummary();
    expect(projection).not.toBeNull();
    // Only the eleven two-meter-complete dates may feed the average — the
    // buggy MIN-over-existing-rows logic admitted D-2 (basisDays 12).
    expect(projection!.basisDays).toBe(11);
    expect(projection!.avgDailyNetP).toBeCloseTo(400, 6);
    // With every complete day netting exactly 400p, the projection collapses
    // to 400 × daysInMonth regardless of where the month boundary falls.
    // Any leakage of D-2/D-1's elec-only actuals breaks this identity.
    const daysInMonth = time.parseLocalDate(today).daysInMonth!;
    expect(projection!.monthEndNetP).toBeCloseTo(400 * daysInMonth, 6);
  });
});
