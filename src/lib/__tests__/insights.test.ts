import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DateTime } from "luxon";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Env MUST be set before any app module is imported: lib/config.ts caches on
// first read and lib/db.ts opens the file at that path.
const dbPath = path.join(os.tmpdir(), `energy-insights-test-${randomUUID()}.db`);
process.env.ENERGY_DB_PATH = dbPath;
process.env.ENERGY_MOCK = "1";
delete process.env.OCTOPUS_PAYMENT_METHOD; // default: DIRECT_DEBIT

const { getInsights } = await import("@/lib/insights");
const { computeDailyCosts } = await import("@/lib/costs");
const { getDb } = await import("@/lib/db");
const time = await import("@/lib/time");

// ENERGY_MOCK=1 makes config rewrite the file name to *.mock.db.
const actualDbPath = dbPath.replace(/\.db$/, ".mock.db");

const ELEC_TARIFF = "E-1R-TEST-IMP-A";
const GAS_TARIFF = "G-1R-TEST-GAS-A";
const EPOCH = "2025-01-01T00:00:00Z";

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

/** Seed every half-hour of a local day, choosing kWh from the LOCAL wall clock. */
function seedFullDay(
  meterPointId: number,
  localDate: string,
  kwhAt: (local: DateTime) => number
): void {
  for (const start of halfHourStarts(localDate)) {
    const local = time.parseInstant(start).setZone("Europe/London");
    insertConsumption(meterPointId, start, kwhAt(local));
  }
}

/** 0.05 kWh in the 01:00–05:00 local baseload window, 0.2 otherwise. */
const baseDay = (local: DateTime): number =>
  local.hour >= 1 && local.hour < 5 ? 0.05 : 0.2;

beforeAll(() => {
  const db = getDb();
  db.prepare(
    "INSERT INTO meter_points (id, fuel, identifier, is_export, unit) VALUES (?, ?, ?, ?, ?)"
  ).run(1, "electricity", "1200000000000", 0, "kwh");
  db.prepare(
    "INSERT INTO meter_points (id, fuel, identifier, is_export, unit) VALUES (?, ?, ?, ?, ?)"
  ).run(2, "gas", "3000000000", 0, "kwh");

  const insertAgreement = db.prepare(
    `INSERT INTO agreements (meter_point_id, tariff_code, product_code, valid_from, valid_to)
     VALUES (?, ?, ?, ?, NULL)`
  );
  insertAgreement.run(1, ELEC_TARIFF, "TEST-IMP", EPOCH);
  insertAgreement.run(2, GAS_TARIFF, "TEST-GAS", EPOCH);

  const insertRate = db.prepare(
    `INSERT INTO unit_rates
       (tariff_code, rate_type, payment_method, valid_from, valid_to, p_exc_vat, p_inc_vat)
     VALUES (?, 'standard', ?, ?, NULL, ?, ?)`
  );
  // Duplicate NON_DD row: only the DIRECT_DEBIT rate (25p) may price anything.
  insertRate.run(ELEC_TARIFF, "DIRECT_DEBIT", EPOCH, 23.81, 25.0);
  insertRate.run(ELEC_TARIFF, "NON_DIRECT_DEBIT", EPOCH, 28.57, 30.0);
  // The gas tariff deliberately has NO unit rates: its peaks must be unpriced.

  // --- Electricity (meter 1), all-BST days -------------------------------
  // Week of Mon 2026-06-22: Mon/Tue complete, Wed complete-but-zero,
  // Thu partial (incomplete), Fri/Sat complete, Sun absent.
  seedFullDay(1, "2026-06-20", baseDay); // Sat, previous ISO week
  seedFullDay(1, "2026-06-21", baseDay); // Sun, previous ISO week
  seedFullDay(1, "2026-06-22", baseDay);
  seedFullDay(1, "2026-06-23", (l) => (l.hour === 18 && l.minute === 0 ? 1.0 : baseDay(l)));
  seedFullDay(1, "2026-06-24", () => 0); // complete day of zero usage
  insertConsumption(1, "2026-06-25T00:00:00Z", 0.9); // 01:00 local (overnight, but day incomplete)
  insertConsumption(1, "2026-06-25T11:00:00Z", 0.85); // 12:00 local
  insertConsumption(1, "2026-06-25T11:30:00Z", 0.8); // 12:30 local
  insertConsumption(1, "2026-06-25T12:00:00Z", 0.2); // 13:00 local
  seedFullDay(1, "2026-06-26", (l) => (l.hour === 12 && l.minute === 0 ? 1.2 : baseDay(l)));
  seedFullDay(1, "2026-06-27", baseDay);
  // Newest stored day: a lone BST half-hour, 10:00Z = 11:00 local = slot 22.
  insertConsumption(1, "2026-07-01T10:00:00Z", 1.5);
  computeDailyCosts(1, [
    "2026-06-20",
    "2026-06-21",
    "2026-06-22",
    "2026-06-23",
    "2026-06-24",
    "2026-06-25",
    "2026-06-26",
    "2026-06-27",
    "2026-07-01",
  ]);

  // --- Gas (meter 2), ending on the 50-half-hour fall-back day -----------
  expect(halfHourStarts("2026-10-25")).toHaveLength(50);
  seedFullDay(2, "2026-10-23", () => 0.1);
  seedFullDay(2, "2026-10-24", () => 0.1);
  seedFullDay(2, "2026-10-25", () => 0.1);
  computeDailyCosts(2, ["2026-10-23", "2026-10-24", "2026-10-25"]);
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

describe("getInsights heatmap", () => {
  it("windows from the oldest stored day to the newest stored day", () => {
    const { heatmap } = getInsights("electricity");
    // 56-day window ending 2026-07-01 would start 2026-05-07; clipped to data.
    expect(heatmap.from).toBe("2026-06-20");
    expect(heatmap.to).toBe("2026-07-01");
    expect(heatmap.days).toHaveLength(12);
    expect(heatmap.days[0].date).toBe("2026-06-20");
    expect(heatmap.days[11].date).toBe("2026-07-01");
  });

  it("maps a BST interval to its local slot: 10:00Z -> slot 22 (11:00 local)", () => {
    const { heatmap } = getInsights("electricity");
    const day = heatmap.days.find((d) => d.date === "2026-07-01")!;
    expect(day.kwh[22]).toBeCloseTo(1.5, 9);
    expect(day.kwh[21]).toBeNull();
    expect(day.kwh[23]).toBeNull();
    expect(heatmap.maxKwh).toBeCloseTo(1.5, 9);
  });

  it("leaves gaps null but keeps zero readings as 0", () => {
    const { heatmap } = getInsights("electricity");
    const absent = heatmap.days.find((d) => d.date === "2026-06-28")!;
    expect(absent.kwh.every((v) => v === null)).toBe(true);
    const partial = heatmap.days.find((d) => d.date === "2026-06-25")!;
    expect(partial.kwh[2]).toBeCloseTo(0.9, 9); // 01:00 local
    expect(partial.kwh[24]).toBeCloseTo(0.85, 9); // 12:00 local
    expect(partial.kwh[0]).toBeNull();
    const zeroDay = heatmap.days.find((d) => d.date === "2026-06-24")!;
    expect(zeroDay.kwh[10]).toBe(0);
  });

  it("sums the repeated hour of the 50-half-hour day onto its 48-slot clock", () => {
    const { heatmap } = getInsights("gas");
    expect(heatmap.from).toBe("2026-10-23");
    expect(heatmap.to).toBe("2026-10-25");
    const foldDay = heatmap.days.find((d) => d.date === "2026-10-25")!;
    // 01:00 and 01:30 local occur twice (BST then GMT): 0.1 + 0.1.
    expect(foldDay.kwh[2]).toBeCloseTo(0.2, 9);
    expect(foldDay.kwh[3]).toBeCloseTo(0.2, 9);
    expect(foldDay.kwh[4]).toBeCloseTo(0.1, 9); // 02:00 local, single
    expect(foldDay.kwh.every((v) => v !== null)).toBe(true);
    expect(heatmap.maxKwh).toBeCloseTo(0.2, 9);
  });
});

describe("getInsights baseload", () => {
  it("takes the median overnight half-hour over complete days only", () => {
    const { baseload } = getInsights("electricity");
    // Complete days: 06-20..24, 26, 27 (7 days). 06-25 is incomplete, so its
    // 0.9 kWh 01:00 reading must NOT contribute a sample day.
    expect(baseload.sampleDays).toBe(7);
    // Samples: 48 x 0.05 + 8 x 0 (the zero day) -> median 0.05 kWh/hh = 100 W.
    expect(baseload.watts).toBeCloseTo(100, 9);
    // 0.1 kW x 8760 h x 25 p/kWh (current DIRECT_DEBIT rate) = 21900 p.
    expect(baseload.annualCostP).toBeCloseTo(21900, 6);
  });

  it("returns null watts/annualCostP below 7 sample days", () => {
    const { baseload } = getInsights("gas");
    expect(baseload.sampleDays).toBe(3);
    expect(baseload.watts).toBeNull();
    expect(baseload.annualCostP).toBeNull();
  });
});

describe("getInsights weekCompare", () => {
  it("anchors on the newest complete day and distinguishes null from zero", () => {
    const { weekCompare } = getInsights("electricity");
    // Newest complete day is Sat 2026-06-27 -> this week = Mon 2026-06-22.
    expect(weekCompare.days.map((d) => d.weekday)).toEqual([
      "Mon",
      "Tue",
      "Wed",
      "Thu",
      "Fri",
      "Sat",
      "Sun",
    ]);
    const byDay = Object.fromEntries(weekCompare.days.map((d) => [d.weekday, d]));
    expect(byDay.Mon.thisWeekKwh).toBeCloseTo(8.4, 9); // 8x0.05 + 40x0.2
    expect(byDay.Tue.thisWeekKwh).toBeCloseTo(9.2, 9); // one 0.2 swapped for 1.0
    expect(byDay.Wed.thisWeekKwh).toBe(0); // complete zero-usage day: 0, not null
    expect(byDay.Thu.thisWeekKwh).toBeNull(); // incomplete day: null, not its partial sum
    expect(byDay.Fri.thisWeekKwh).toBeCloseTo(9.4, 9);
    expect(byDay.Sat.thisWeekKwh).toBeCloseTo(8.4, 9);
    expect(byDay.Sun.thisWeekKwh).toBeNull(); // no row at all
    expect(byDay.Mon.lastWeekKwh).toBeNull();
    expect(byDay.Sat.lastWeekKwh).toBeCloseTo(8.4, 9);
    expect(byDay.Sun.lastWeekKwh).toBeCloseTo(8.4, 9);
    expect(weekCompare.thisWeekTotalKwh).toBeCloseTo(35.4, 9);
    expect(weekCompare.lastWeekTotalKwh).toBeCloseTo(16.8, 9);
    // deltaPct is like-for-like over weekdays complete in BOTH weeks — here
    // only Saturday (8.4 vs 8.4), so 0. The raw totals would have claimed
    // +111% by comparing a 5-complete-day week against a 2-day one.
    expect(weekCompare.deltaPct).toBeCloseTo(0, 9);
  });

  it("reports deltaPct null (not 0 or Infinity) when last week has no data", () => {
    const { weekCompare } = getInsights("gas");
    // Newest complete gas day is Sun 2026-10-25 -> this week = Mon 2026-10-19.
    expect(weekCompare.thisWeekTotalKwh).toBeCloseTo(4.8 + 4.8 + 5.0, 9);
    expect(weekCompare.lastWeekTotalKwh).toBe(0);
    expect(weekCompare.deltaPct).toBeNull();
  });
});

describe("getInsights peaks", () => {
  it("returns the top 5 half-hours descending with billed costP", () => {
    const { peaks } = getInsights("electricity");
    expect(peaks.map((p) => p.intervalStart)).toEqual([
      "2026-07-01T10:00:00Z", // 1.5
      "2026-06-26T11:00:00Z", // 1.2 at 12:00 local
      "2026-06-23T17:00:00Z", // 1.0 at 18:00 local
      "2026-06-25T00:00:00Z", // 0.9
      "2026-06-25T11:00:00Z", // 0.85
    ]);
    expect(peaks.map((p) => p.kwh)).toEqual([1.5, 1.2, 1.0, 0.9, 0.85]);
    // Priced at the 25p DIRECT_DEBIT rate with billing rounding.
    expect(peaks.map((p) => p.costP)).toEqual([37.5, 30, 25, 22.5, 21.25]);
  });

  it("prices unrated intervals as null", () => {
    const { peaks } = getInsights("gas");
    expect(peaks).toHaveLength(5);
    for (const p of peaks) {
      expect(p.kwh).toBeCloseTo(0.1, 9);
      expect(p.costP).toBeNull();
    }
  });
});
