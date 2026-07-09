import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Env MUST be set before any app module is imported: lib/config.ts caches on
// first read and lib/db.ts opens the file at that path.
const dbPath = path.join(os.tmpdir(), `energy-unpriced-test-${randomUUID()}.db`);
process.env.ENERGY_DB_PATH = dbPath;
process.env.ENERGY_MOCK = "1";
delete process.env.OCTOPUS_PAYMENT_METHOD;

const { computeDailyCosts, recomputeUnpricedDays } = await import("@/lib/costs");
const { getUsage } = await import("@/lib/aggregate");
const { getDb } = await import("@/lib/db");
const time = await import("@/lib/time");

const actualDbPath = dbPath.replace(/\.db$/, ".mock.db");
const TARIFF = "E-1R-TEST-LATE-A";
const DAY = "2026-02-10";

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

describe("days costed before their rates arrive", () => {
  it("marks them unpriced, reports costP null, and heals on recompute", () => {
    const db = getDb();
    db.prepare(
      "INSERT INTO meter_points (id, fuel, identifier, is_export, unit) VALUES (1, 'electricity', '1200000000099', 0, 'kwh')"
    ).run();
    db.prepare(
      `INSERT INTO agreements (meter_point_id, tariff_code, product_code, valid_from, valid_to)
       VALUES (1, ?, 'TEST-LATE', '2025-01-01T00:00:00Z', NULL)`
    ).run(TARIFF);

    // Consumption lands, but the rates sync hasn't succeeded yet.
    const { startUtc } = time.localDayBoundsUtc(DAY);
    let t = time.parseInstant(startUtc);
    const insert = db.prepare(
      `INSERT INTO consumption (meter_point_id, interval_start, interval_end, value_raw, kwh, fetched_at)
       VALUES (1, ?, ?, ?, ?, ?)`
    );
    for (let i = 0; i < 4; i++) {
      insert.run(
        time.utcIso(t),
        time.utcIso(t.plus({ minutes: 30 })),
        0.2,
        0.2,
        time.nowUtcIso()
      );
      t = t.plus({ minutes: 30 });
    }
    computeDailyCosts(1, [DAY]);

    const before = db
      .prepare("SELECT * FROM daily_costs WHERE meter_point_id = 1 AND local_date = ?")
      .get(DAY) as { intervals_present: number; intervals_priced: number; energy_p: number };
    expect(before.intervals_present).toBe(4);
    expect(before.intervals_priced).toBe(0);
    expect(before.energy_p).toBe(0);

    // The day/week/month usage contract: unpriced buckets report costP null,
    // never a confidently wrong £0.00.
    const unpriced = getUsage("electricity", false, DAY, DAY, "day");
    expect(unpriced.points).toHaveLength(1);
    expect(unpriced.points[0].kwh).toBeCloseTo(0.8, 9);
    expect(unpriced.points[0].costP).toBeNull();

    // Rates arrive late; the post-rates-sync heal re-prices the day.
    db.prepare(
      `INSERT INTO unit_rates (tariff_code, rate_type, payment_method, valid_from, valid_to, p_exc_vat, p_inc_vat)
       VALUES (?, 'standard', 'DIRECT_DEBIT', '2025-01-01T00:00:00Z', NULL, 23.81, 25.0)`
    ).run(TARIFF);
    db.prepare(
      `INSERT INTO standing_charges (tariff_code, payment_method, valid_from, valid_to, p_exc_vat, p_inc_vat)
       VALUES (?, 'DIRECT_DEBIT', '2025-01-01T00:00:00Z', NULL, 57.14, 60.0)`
    ).run(TARIFF);
    recomputeUnpricedDays();

    const after = db
      .prepare("SELECT * FROM daily_costs WHERE meter_point_id = 1 AND local_date = ?")
      .get(DAY) as { intervals_priced: number; energy_p: number; standing_p: number };
    expect(after.intervals_priced).toBe(4);
    expect(after.energy_p).toBeCloseTo(4 * 0.2 * 25, 6); // 20 p
    expect(after.standing_p).toBeCloseTo(60.0, 6);

    const priced = getUsage("electricity", false, DAY, DAY, "day");
    expect(priced.points[0].costP).toBeCloseTo(20.0, 6);
  });
});
