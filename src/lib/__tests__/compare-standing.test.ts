import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterAll } from "vitest";

// Env MUST be set before any app module is imported.
const dbPath = path.join(os.tmpdir(), `energy-standing-test-${randomUUID()}.db`);
process.env.ENERGY_DB_PATH = dbPath;
process.env.ENERGY_MOCK = "1";
delete process.env.OCTOPUS_PAYMENT_METHOD;

const { getComparison } = await import("@/lib/compare");
const { recomputeDaysForIntervals } = await import("@/lib/costs");
const { getDb, setState } = await import("@/lib/db");
const time = await import("@/lib/time");

const actualDbPath = dbPath.replace(/\.db$/, ".mock.db");

const CURRENT_TARIFF = "E-1R-CURR-A";
const CANDIDATE_TARIFF = "E-1R-CAND-A";

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
 * Review regression: candidate standing charges must accrue over exactly
 * the local days the CURRENT tariff was billed for (days with a daily_costs
 * row). Charging candidates for range days whose data hasn't landed
 * (yesterday, comms gaps) skews every comparison against the alternatives.
 */
describe("getComparison standing-charge symmetry", () => {
  it("skips range days without a daily_costs row on both sides", () => {
    const db = getDb();
    db.prepare(
      "INSERT INTO meter_points (id, fuel, identifier, is_export, unit) VALUES (1, 'electricity', '1200000000020', 0, 'kwh')"
    ).run();
    db.prepare(
      `INSERT INTO agreements (meter_point_id, tariff_code, product_code, valid_from, valid_to)
       VALUES (1, ?, 'CURR', '2025-01-01T00:00:00Z', NULL)`
    ).run(CURRENT_TARIFF);

    const insertRate = db.prepare(
      `INSERT INTO unit_rates (tariff_code, rate_type, payment_method, valid_from, valid_to, p_exc_vat, p_inc_vat)
       VALUES (?, 'standard', ?, '2025-01-01T00:00:00Z', NULL, ?, ?)`
    );
    insertRate.run(CURRENT_TARIFF, "DIRECT_DEBIT", 19.05, 20.0);
    insertRate.run(CANDIDATE_TARIFF, "", 9.52, 10.0);
    const insertCharge = db.prepare(
      `INSERT INTO standing_charges (tariff_code, payment_method, valid_from, valid_to, p_exc_vat, p_inc_vat)
       VALUES (?, ?, '2025-01-01T00:00:00Z', NULL, ?, ?)`
    );
    insertCharge.run(CURRENT_TARIFF, "DIRECT_DEBIT", 47.62, 50.0);
    insertCharge.run(CANDIDATE_TARIFF, "", 38.1, 40.0);

    setState(
      "compare_candidates",
      JSON.stringify([
        {
          productCode: "CAND",
          displayName: "Candidate",
          fuel: "electricity",
          tariffCode: CANDIDATE_TARIFF,
        },
      ])
    );
    setState("compare_candidates_synced_at", time.nowUtcIso());

    // Consumption on Feb 2 and Feb 3 only; daily_costs seeded the way
    // production does (recomputeDaysForIntervals over landed intervals), so
    // Feb 4 has NO row despite sitting inside the requested range.
    const insertConsumption = db.prepare(
      `INSERT INTO consumption (meter_point_id, interval_start, interval_end, value_raw, kwh, fetched_at)
       VALUES (1, ?, ?, ?, ?, ?)`
    );
    const starts: string[] = [];
    for (const date of ["2026-02-02", "2026-02-03"]) {
      let t = time.parseInstant(time.localDayBoundsUtc(date).startUtc);
      for (let i = 0; i < 4; i++) {
        const start = time.utcIso(t);
        insertConsumption.run(start, time.utcIso(t.plus({ minutes: 30 })), 0.5, 0.5, time.nowUtcIso());
        starts.push(start);
        t = t.plus({ minutes: 30 });
      }
    }
    recomputeDaysForIntervals(1, starts);

    const result = getComparison("2026-02-02", "2026-02-04");
    const current = result.quotes.find((q) => q.isCurrent)!;
    const candidate = result.quotes.find((q) => !q.isCurrent)!;

    // Two billed days on each side — never three for the candidate.
    expect(current.standingP).toBeCloseTo(2 * 50.0, 6);
    expect(candidate.standingP).toBeCloseTo(2 * 40.0, 6);
    // Energy: 8 half-hours × 0.5 kWh × 10p, billing-rounded per half-hour.
    expect(candidate.energyP).toBeCloseTo(8 * 0.5 * 10.0, 6);
    expect(candidate.coveragePct).toBe(100);
    // Same day-set on both sides means the delta reflects rates alone.
    expect(current.totalP - candidate.totalP).toBeCloseTo(
      8 * 0.5 * (20.0 - 10.0) + 2 * (50.0 - 40.0),
      6
    );
  });
});
