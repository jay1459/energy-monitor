import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Env MUST be set before any app module is imported: lib/config.ts caches on
// first read and lib/db.ts opens the file at that path.
const dbPath = path.join(os.tmpdir(), `energy-aggregate-test-${randomUUID()}.db`);
process.env.ENERGY_DB_PATH = dbPath;
process.env.ENERGY_MOCK = "1";
delete process.env.OCTOPUS_PAYMENT_METHOD; // default: DIRECT_DEBIT

const { computeDailyCosts } = await import("@/lib/costs");
const aggregate = await import("@/lib/aggregate");
const { getDb } = await import("@/lib/db");
const time = await import("@/lib/time");

const actualDbPath = dbPath.replace(/\.db$/, ".mock.db");

const IMPORT_TARIFF = "E-1R-TEST-IMP-A";
const EXPORT_TARIFF = "E-1R-TEST-EXP-A";
const EPOCH = "2025-01-01T00:00:00Z";

// 2026-03-28 (Saturday, 48 HH) and 2026-03-29 (Sunday, spring forward, 46 HH)
// share the ISO week starting Monday 2026-03-23.
const GMT_DAY = "2026-03-28";
const DST_DAY = "2026-03-29";

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
    "INSERT INTO meter_points (id, fuel, identifier, is_export, unit, label) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(1, "electricity", "1200000000000", 0, "kwh", "Import");
  db.prepare(
    "INSERT INTO meter_points (id, fuel, identifier, is_export, unit, label) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(2, "electricity", "1200000000001", 1, "kwh", null);

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
  insertRate.run(IMPORT_TARIFF, "DIRECT_DEBIT", EPOCH, 23.81, 25.0);
  insertRate.run(IMPORT_TARIFF, "NON_DIRECT_DEBIT", EPOCH, 28.57, 30.0);
  insertRate.run(EXPORT_TARIFF, "", EPOCH, 15.0, 15.0);

  db.prepare(
    `INSERT INTO standing_charges
       (tariff_code, payment_method, valid_from, valid_to, p_exc_vat, p_inc_vat)
     VALUES (?, ?, ?, NULL, ?, ?)`
  ).run(IMPORT_TARIFF, "DIRECT_DEBIT", EPOCH, 57.14, 60.0);

  // Import: 0.1 kWh every half-hour on both sides of the BST boundary.
  for (const start of halfHourStarts(GMT_DAY)) insertConsumption(1, start, 0.1);
  for (const start of halfHourStarts(DST_DAY)) insertConsumption(1, start, 0.1);
  // Export: 4 half-hours of 0.5 kWh on the GMT day.
  for (const start of halfHourStarts(GMT_DAY).slice(20, 24)) {
    insertConsumption(2, start, 0.5);
  }

  computeDailyCosts(1, [GMT_DAY, DST_DAY]);
  computeDailyCosts(2, [GMT_DAY]);

  // Live telemetry: one fresh reading (read_at = now is always today-local).
  db.prepare(
    `INSERT INTO telemetry
       (device_id, read_at, demand_w, consumption_wh, export_wh, consumption_delta_wh, cost_delta_p)
     VALUES (?, ?, ?, ?, NULL, ?, ?)`
  ).run("test-device", time.nowUtcIso(), 1200, 5000, 250, 6.25);
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

describe("getUsage", () => {
  it("buckets days by Europe/London calendar day across the BST boundary", () => {
    const usage = aggregate.getUsage("electricity", false, GMT_DAY, DST_DAY, "day");
    expect(usage.points).toHaveLength(2);
    expect(usage.points[0]!.t).toBe(GMT_DAY);
    expect(usage.points[0]!.kwh).toBeCloseTo(4.8, 9); // 48 half-hours
    expect(usage.points[0]!.costP).toBeCloseTo(48 * 0.1 * 25, 6); // energy only
    expect(usage.points[1]!.t).toBe(DST_DAY);
    expect(usage.points[1]!.kwh).toBeCloseTo(4.6, 9); // 46 half-hours
    expect(usage.points[1]!.costP).toBeCloseTo(46 * 0.1 * 25, 6);
  });

  it("returns 94 half-hour points spanning the short day", () => {
    const usage = aggregate.getUsage("electricity", false, GMT_DAY, DST_DAY, "halfhour");
    expect(usage.points).toHaveLength(94);
    expect(usage.points[0]!.t).toBe("2026-03-28T00:00:00Z");
    // Local 2026-03-29 ends at 23:00Z, so its last half-hour starts 22:30Z.
    expect(usage.points[93]!.t).toBe("2026-03-29T22:30:00Z");
    expect(usage.points[0]!.costP).toBeCloseTo(0.1 * 25, 6);
  });

  it("groups both days into the ISO week starting Monday 2026-03-23", () => {
    const usage = aggregate.getUsage("electricity", false, GMT_DAY, DST_DAY, "week");
    expect(usage.points).toHaveLength(1);
    expect(usage.points[0]!.t).toBe("2026-03-23");
    expect(usage.points[0]!.kwh).toBeCloseTo(9.4, 9);
    expect(usage.points[0]!.costP).toBeCloseTo(235.0, 6);
  });

  it("groups by calendar month", () => {
    const usage = aggregate.getUsage("electricity", false, GMT_DAY, DST_DAY, "month");
    expect(usage.points).toHaveLength(1);
    expect(usage.points[0]!.t).toBe("2026-03-01");
    expect(usage.points[0]!.kwh).toBeCloseTo(9.4, 9);
  });

  it("keeps import and export meter points apart", () => {
    const usage = aggregate.getUsage("electricity", true, GMT_DAY, DST_DAY, "day");
    expect(usage.points).toHaveLength(1);
    expect(usage.points[0]!.kwh).toBeCloseTo(2.0, 9);
    expect(usage.points[0]!.costP).toBeCloseTo(4 * 0.5 * 15, 6); // 30 p earnings
  });

  it("returns no points for an absent meter", () => {
    const usage = aggregate.getUsage("gas", false, GMT_DAY, DST_DAY, "day");
    expect(usage.points).toHaveLength(0);
  });
});

describe("getCosts", () => {
  it("splits totals into import cost and export earnings", () => {
    const costs = aggregate.getCosts(GMT_DAY, DST_DAY);
    expect(costs.days).toHaveLength(3); // 2 import days + 1 export day
    // Import: (120 + 60) + (115 + 60); export: 4 x 0.5 x 15.
    expect(costs.totals.importP).toBeCloseTo(355.0, 6);
    expect(costs.totals.exportP).toBeCloseTo(30.0, 6);
    expect(costs.totals.netP).toBeCloseTo(325.0, 6);
    const exportDay = costs.days.find((d) => d.isExport)!;
    expect(exportDay.complete).toBe(false); // 4 of 48 half-hours
    expect(exportDay.standingP).toBe(0);
    const importDst = costs.days.find((d) => !d.isExport && d.date === DST_DAY)!;
    expect(importDst.complete).toBe(true);
  });
});

describe("getStatus / getMeterStatuses", () => {
  it("reports freshness and completeness per meter point", () => {
    const statuses = aggregate.getMeterStatuses();
    expect(statuses).toHaveLength(2);
    const imp = statuses.find((s) => !s.isExport)!;
    expect(imp.label).toBe("Import");
    expect(imp.tariffCode).toBe(IMPORT_TARIFF);
    expect(imp.latestIntervalEnd).toBe("2026-03-29T23:00:00Z");
    expect(imp.completeThroughLocalDate).toBe(DST_DAY);
    const exp = statuses.find((s) => s.isExport)!;
    expect(exp.label).toBe("Electricity export"); // null label fallback
    expect(exp.completeThroughLocalDate).toBeNull(); // only a partial day
  });

  it("reports mode and telemetry availability", () => {
    const status = aggregate.getStatus();
    expect(status.mode).toBe("mock");
    expect(status.telemetryAvailable).toBe(true);
    expect(status.meters).toHaveLength(2);
  });
});

describe("getLive", () => {
  it("sums today's telemetry deltas from the fresh reading", () => {
    const live = aggregate.getLive();
    expect(live.available).toBe(true);
    expect(live.demandW).toBe(1200);
    expect(live.todayKwh).toBeCloseTo(0.25, 9); // 250 Wh
    expect(live.todayCostP).toBeCloseTo(6.25, 9);
  });
});

describe("getCurrentRates", () => {
  it("resolves the current unit rate and standing charge per meter point", () => {
    const { rates } = aggregate.getCurrentRates();
    const imp = rates.find((r) => !r.isExport)!;
    expect(imp.tariffCode).toBe(IMPORT_TARIFF);
    expect(imp.unitRatePIncVat).toBe(25.0); // DIRECT_DEBIT row, not NON_DD 30p
    expect(imp.standingPIncVat).toBe(60.0);
    const exp = rates.find((r) => r.isExport)!;
    expect(exp.tariffCode).toBe(EXPORT_TARIFF);
    expect(exp.unitRatePIncVat).toBe(15.0); // '' payment-method fallback
    expect(exp.standingPIncVat).toBe(0);
  });
});

describe("getSummary", () => {
  it("reports the complete-through date across import meters", () => {
    const summary = aggregate.getSummary();
    // Seeded data is March 2026, so it never lands in the real "yesterday"
    // or current-month windows; the complete-through date is clock-free.
    expect(summary.completeThroughLocalDate).toBe(DST_DAY);
    expect(Number.isFinite(summary.monthToDate.importP)).toBe(true);
    expect(summary.monthToDate.netP).toBe(
      summary.monthToDate.importP - summary.monthToDate.exportP
    );
  });
});
