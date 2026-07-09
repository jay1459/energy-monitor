import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DateTime } from "luxon";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Env MUST be set before any app module is imported: lib/config.ts caches on
// first read and lib/db.ts opens the file at that path.
const dbPath = path.join(os.tmpdir(), `energy-costs-test-${randomUUID()}.db`);
process.env.ENERGY_DB_PATH = dbPath;
process.env.ENERGY_MOCK = "1";
delete process.env.OCTOPUS_PAYMENT_METHOD; // default: DIRECT_DEBIT

const { computeDailyCosts, recomputeDaysForIntervals } = await import("@/lib/costs");
const { getDb } = await import("@/lib/db");
const time = await import("@/lib/time");

// ENERGY_MOCK=1 makes config rewrite the file name to *.mock.db.
const actualDbPath = dbPath.replace(/\.db$/, ".mock.db");

const IMPORT_TARIFF = "E-1R-TEST-IMP-A";
const EXPORT_TARIFF = "E-1R-TEST-EXP-A";
const EPOCH = "2025-01-01T00:00:00Z";

interface DailyCostRow {
  kwh: number;
  intervals_present: number;
  intervals_expected: number;
  energy_p: number;
  standing_p: number;
  total_p: number;
  computed_at: string;
}

function dailyCost(meterPointId: number, localDate: string): DailyCostRow {
  const row = getDb()
    .prepare("SELECT * FROM daily_costs WHERE meter_point_id = ? AND local_date = ?")
    .get(meterPointId, localDate) as DailyCostRow | undefined;
  if (!row) throw new Error(`no daily_costs row for ${meterPointId}/${localDate}`);
  return row;
}

/** All half-hour interval starts of a Europe/London local day, canonical UTC. */
function halfHourStarts(localDate: string): string[] {
  const { startUtc, endUtc } = time.localDayBoundsUtc(localDate);
  const end = time.parseInstant(endUtc);
  const out: string[] = [];
  let t = time.parseInstant(startUtc);
  while (t < end) {
    out.push(time.utcIso(t));
    t = t.plus({ minutes: 30 });
  }
  return out;
}

function insertConsumption(meterPointId: number, startUtc: string, kwh: number): void {
  const endUtc = time.utcIso(time.parseInstant(startUtc).plus({ minutes: 30 }));
  getDb()
    .prepare(
      `INSERT INTO consumption
         (meter_point_id, interval_start, interval_end, value_raw, kwh, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(meterPointId, startUtc, endUtc, kwh, kwh, time.nowUtcIso());
}

beforeAll(() => {
  const db = getDb();
  db.prepare(
    "INSERT INTO meter_points (id, fuel, identifier, is_export, unit) VALUES (?, ?, ?, ?, ?)"
  ).run(1, "electricity", "1200000000000", 0, "kwh");
  db.prepare(
    "INSERT INTO meter_points (id, fuel, identifier, is_export, unit) VALUES (?, ?, ?, ?, ?)"
  ).run(2, "electricity", "1200000000001", 1, "kwh");

  const insertAgreement = db.prepare(
    `INSERT INTO agreements (meter_point_id, tariff_code, product_code, valid_from, valid_to)
     VALUES (?, ?, ?, ?, NULL)`
  );
  insertAgreement.run(1, IMPORT_TARIFF, "TEST-IMP", EPOCH);
  insertAgreement.run(2, EXPORT_TARIFF, "TEST-EXP", EPOCH);

  const insertRate = db.prepare(
    `INSERT INTO unit_rates
       (tariff_code, rate_type, payment_method, valid_from, valid_to, p_exc_vat, p_inc_vat)
     VALUES (?, 'standard', ?, ?, NULL, ?, ?)`
  );
  // DIRECT_DEBIT and NON_DIRECT_DEBIT duplicates: only the DD row (25p) may be used.
  insertRate.run(IMPORT_TARIFF, "DIRECT_DEBIT", EPOCH, 23.81, 25.0);
  insertRate.run(IMPORT_TARIFF, "NON_DIRECT_DEBIT", EPOCH, 28.57, 30.0);
  // Export rates come back with a null payment method ('' in the DB).
  insertRate.run(EXPORT_TARIFF, "", EPOCH, 15.0, 15.0);

  const insertCharge = db.prepare(
    `INSERT INTO standing_charges
       (tariff_code, payment_method, valid_from, valid_to, p_exc_vat, p_inc_vat)
     VALUES (?, ?, ?, NULL, ?, ?)`
  );
  insertCharge.run(IMPORT_TARIFF, "DIRECT_DEBIT", EPOCH, 57.14, 60.0);
  insertCharge.run(IMPORT_TARIFF, "NON_DIRECT_DEBIT", EPOCH, 61.9, 65.0);
  // No standing charge rows for the export tariff.

  // 2026-01-15 (plain GMT day, 48 HH): 46 x 0.1 kWh, then 0.125 and 0.135
  // to exercise banker's rounding in the billed sum.
  const winterStarts = halfHourStarts("2026-01-15");
  expect(winterStarts).toHaveLength(48);
  winterStarts.forEach((start, i) => {
    const kwh = i === 46 ? 0.125 : i === 47 ? 0.135 : 0.1;
    insertConsumption(1, start, kwh);
  });

  // 2026-03-29 (spring forward, 46 HH): 0.1 kWh everywhere.
  const dstStarts = halfHourStarts("2026-03-29");
  expect(dstStarts).toHaveLength(46);
  for (const start of dstStarts) insertConsumption(1, start, 0.1);

  // Export meter: 10 half-hours of 0.25 kWh on 2026-01-15 (partial day).
  for (const start of winterStarts.slice(20, 30)) insertConsumption(2, start, 0.25);

  computeDailyCosts(1, ["2026-01-15", "2026-03-29", "2026-01-17"]);
  computeDailyCosts(2, ["2026-01-15"]);
});

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

describe("computeDailyCosts", () => {
  it("bills a complete import day to the penny with banker's-rounded kWh", () => {
    const row = dailyCost(1, "2026-01-15");
    expect(row.intervals_expected).toBe(48);
    expect(row.intervals_present).toBe(48);
    expect(row.kwh).toBeCloseTo(4.86, 9);
    // 46 x round(0.1)=0.10 + round(0.125)=0.12 + round(0.135)=0.14 -> 4.86 kWh
    // billed at 25 p/kWh = 121.5 p.
    expect(row.energy_p).toBeCloseTo(121.5, 6);
    expect(row.standing_p).toBeCloseTo(60.0, 6);
    expect(row.total_p).toBeCloseTo(181.5, 6);
  });

  it("uses the DIRECT_DEBIT rows, not the NON_DIRECT_DEBIT duplicates", () => {
    const row = dailyCost(1, "2026-01-15");
    // NON_DD would have been 4.86 * 30 = 145.8 energy and 65 standing.
    expect(row.energy_p).not.toBeCloseTo(145.8, 6);
    expect(row.standing_p).not.toBeCloseTo(65.0, 6);
  });

  it("expects 46 intervals on the spring-forward day and one standing charge", () => {
    const row = dailyCost(1, "2026-03-29");
    expect(row.intervals_expected).toBe(46);
    expect(row.intervals_present).toBe(46);
    expect(row.kwh).toBeCloseTo(4.6, 9);
    expect(row.energy_p).toBeCloseTo(46 * 0.1 * 25, 6); // 115 p
    expect(row.standing_p).toBeCloseTo(60.0, 6); // exactly one despite 46 HH
    expect(row.total_p).toBeCloseTo(175.0, 6);
  });

  it("treats export days as earnings with no standing charge", () => {
    const row = dailyCost(2, "2026-01-15");
    expect(row.intervals_present).toBe(10);
    expect(row.intervals_expected).toBe(48);
    expect(row.kwh).toBeCloseTo(2.5, 9);
    expect(row.energy_p).toBeCloseTo(10 * 0.25 * 15, 6); // 37.5 p via '' fallback
    expect(row.standing_p).toBe(0);
    expect(row.total_p).toBeCloseTo(37.5, 6);
  });

  it("still charges standing on a day with no consumption yet", () => {
    const row = dailyCost(1, "2026-01-17");
    expect(row.intervals_present).toBe(0);
    expect(row.intervals_expected).toBe(48);
    expect(row.kwh).toBe(0);
    expect(row.energy_p).toBe(0);
    expect(row.standing_p).toBeCloseTo(60.0, 6);
    expect(row.total_p).toBeCloseTo(60.0, 6);
  });

  it("is idempotent (upsert, not insert)", () => {
    computeDailyCosts(1, ["2026-01-15"]);
    computeDailyCosts(1, ["2026-01-15"]);
    const row = dailyCost(1, "2026-01-15");
    expect(row.total_p).toBeCloseTo(181.5, 6);
  });
});

describe("recomputeDaysForIntervals", () => {
  it("recomputes each distinct local day of the interval starts", () => {
    // Includes the day's last half-hour, whose interval_end crosses local
    // midnight — the START's local day is what defines membership.
    insertConsumption(1, "2026-01-16T00:00:00Z", 0.1);
    insertConsumption(1, "2026-01-16T23:30:00Z", 0.1);
    recomputeDaysForIntervals(1, [
      "2026-01-16T00:00:00Z",
      "2026-01-16T23:30:00Z",
      "2026-01-16T23:30:00Z", // duplicate must not double-compute or throw
    ]);
    const row = dailyCost(1, "2026-01-16");
    expect(row.intervals_present).toBe(2);
    expect(row.intervals_expected).toBe(48);
    expect(row.energy_p).toBeCloseTo(2 * 0.1 * 25, 6); // 5 p
    expect(row.standing_p).toBeCloseTo(60.0, 6);
    expect(row.total_p).toBeCloseTo(65.0, 6);
  });

  it("is a no-op for an empty interval list", () => {
    expect(() => recomputeDaysForIntervals(1, [])).not.toThrow();
  });
});

describe("DST sanity", () => {
  it("agrees with luxon that 2026-03-29 has 46 half-hours", () => {
    expect(time.halfHoursInLocalDay("2026-03-29")).toBe(46);
    const local = DateTime.fromISO("2026-03-29T00:00:00", { zone: "Europe/London" });
    expect(local.plus({ days: 1 }).startOf("day").diff(local, "hours").hours).toBe(23);
  });
});
