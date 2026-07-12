import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CompareResponse, TariffQuote } from "@/lib/types";

// Env MUST be set before any app module is imported: lib/config.ts caches on
// first read and lib/db.ts opens the file at that path.
const dbPath = path.join(os.tmpdir(), `energy-compare-test-${randomUUID()}.db`);
process.env.ENERGY_DB_PATH = dbPath;
process.env.ENERGY_MOCK = "1";
delete process.env.OCTOPUS_PAYMENT_METHOD; // default: DIRECT_DEBIT

const { syncCompareCandidates } = await import("@/collector/compare");
const { getComparison } = await import("@/lib/compare");
const { computeDailyCosts } = await import("@/lib/costs");
const { getDb, getState, setState } = await import("@/lib/db");
const time = await import("@/lib/time");

// ENERGY_MOCK=1 makes config rewrite the file name to *.mock.db.
const actualDbPath = dbPath.replace(/\.db$/, ".mock.db");

const CUR_ELEC = "E-1R-CUR-FLEX-A";
const CUR_GAS = "G-1R-CUR-FLEX-A";
const CAND_FULL = "E-1R-CANDA-A"; // rates cover the whole range
const CAND_PART = "E-1R-CANDB-A"; // rates cover only the first day
const CAND_GAS = "G-1R-CANDG-A";
const EPOCH = "2025-01-01T00:00:00Z";

// Three plain GMT days. Elec consumption sits on days 1-2, day 3 is empty
// (standing charge must still accrue for it).
const FROM = "2026-01-15";
const MID = "2026-01-16";
const TO = "2026-01-17";
const SYNCED_AT = "2026-01-18T12:00:00Z";

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

let response: CompareResponse;

function quote(tariffCode: string): TariffQuote {
  const q = response.quotes.find((x) => x.tariffCode === tariffCode);
  if (!q) throw new Error(`no quote for ${tariffCode}`);
  return q;
}

beforeAll(() => {
  const db = getDb();
  db.prepare(
    "INSERT INTO meter_points (id, fuel, identifier, is_export, unit) VALUES (?, ?, ?, ?, ?)"
  ).run(1, "electricity", "1200000000000", 0, "kwh");
  db.prepare(
    "INSERT INTO meter_points (id, fuel, identifier, is_export, unit) VALUES (?, ?, ?, ?, ?)"
  ).run(2, "gas", "3900000000", 0, "kwh");

  const insertAgreement = db.prepare(
    `INSERT INTO agreements (meter_point_id, tariff_code, product_code, valid_from, valid_to)
     VALUES (?, ?, ?, ?, NULL)`
  );
  insertAgreement.run(1, CUR_ELEC, "CUR-FLEX", EPOCH);
  insertAgreement.run(2, CUR_GAS, "CUR-FLEX", EPOCH);

  const insertRate = db.prepare(
    `INSERT INTO unit_rates
       (tariff_code, rate_type, payment_method, valid_from, valid_to, p_exc_vat, p_inc_vat)
     VALUES (?, 'standard', ?, ?, ?, ?, ?)`
  );
  // Current tariffs (DIRECT_DEBIT + a NON_DIRECT_DEBIT decoy that must lose).
  insertRate.run(CUR_ELEC, "DIRECT_DEBIT", EPOCH, null, 23.81, 25.0);
  insertRate.run(CUR_ELEC, "NON_DIRECT_DEBIT", EPOCH, null, 28.57, 30.0);
  insertRate.run(CUR_GAS, "DIRECT_DEBIT", EPOCH, null, 5.71, 6.0);
  // Candidate A: 20p everywhere, '' payment method (null from the API).
  insertRate.run(CAND_FULL, "", EPOCH, null, 19.05, 20.0);
  // Candidate B: 5p covering ONLY day 1, plus a NON_DD decoy at 99p.
  insertRate.run(CAND_PART, "DIRECT_DEBIT", "2026-01-15T00:00:00Z", "2026-01-16T00:00:00Z", 4.76, 5.0);
  insertRate.run(CAND_PART, "NON_DIRECT_DEBIT", "2026-01-15T00:00:00Z", "2026-01-16T00:00:00Z", 94.29, 99.0);
  // Gas candidate: 5p everywhere.
  insertRate.run(CAND_GAS, "", EPOCH, null, 4.76, 5.0);

  const insertCharge = db.prepare(
    `INSERT INTO standing_charges
       (tariff_code, payment_method, valid_from, valid_to, p_exc_vat, p_inc_vat)
     VALUES (?, ?, ?, NULL, ?, ?)`
  );
  insertCharge.run(CUR_ELEC, "DIRECT_DEBIT", EPOCH, 57.14, 60.0);
  insertCharge.run(CUR_ELEC, "NON_DIRECT_DEBIT", EPOCH, 61.9, 65.0);
  insertCharge.run(CUR_GAS, "DIRECT_DEBIT", EPOCH, 28.57, 30.0);
  insertCharge.run(CAND_FULL, "DIRECT_DEBIT", EPOCH, 38.1, 40.0);
  insertCharge.run(CAND_PART, "DIRECT_DEBIT", EPOCH, 9.52, 10.0);
  insertCharge.run(CAND_GAS, "DIRECT_DEBIT", EPOCH, 23.81, 25.0);

  // Elec day 1: 0.125 -> 0.12 and 0.145 -> 0.14 under banker's rounding, so
  // billed kWh (0.46) differs from raw kWh (0.47) and the difference is
  // observable in candidate energy math.
  const day1 = halfHourStarts(FROM);
  insertConsumption(1, day1[0], 0.125);
  insertConsumption(1, day1[1], 0.145);
  insertConsumption(1, day1[2], 0.1);
  insertConsumption(1, day1[3], 0.1);
  // Elec day 2: 2 x 0.2. Day 3: nothing.
  const day2 = halfHourStarts(MID);
  insertConsumption(1, day2[0], 0.2);
  insertConsumption(1, day2[1], 0.2);
  // Gas day 1: 2 x 1.0.
  insertConsumption(2, day1[0], 1.0);
  insertConsumption(2, day1[1], 1.0);

  // Current-tariff daily_costs rows for the whole range (day 3 = standing only).
  computeDailyCosts(1, [FROM, MID, TO]);
  computeDailyCosts(2, [FROM, MID, TO]);

  setState(
    "compare_candidates",
    JSON.stringify([
      { productCode: "CANDA", displayName: "Candidate Full", fuel: "electricity", tariffCode: CAND_FULL },
      { productCode: "CANDB", displayName: "Candidate Part", fuel: "electricity", tariffCode: CAND_PART },
      { productCode: "CANDG", displayName: "Candidate Gas", fuel: "gas", tariffCode: CAND_GAS },
    ])
  );
  setState("compare_candidates_synced_at", SYNCED_AT);

  response = getComparison(FROM, TO);
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

describe("getComparison", () => {
  it("returns the requested range and candidate sync metadata", () => {
    expect(response.from).toBe(FROM);
    expect(response.to).toBe(TO);
    expect(response.dayCount).toBe(3);
    expect(response.candidatesSyncedAt).toBe(SYNCED_AT);
    expect(response.quotes).toHaveLength(5);
  });

  it("prices candidate energy with billing-rounded kWh", () => {
    const q = quote(CAND_FULL);
    // Billed kWh: 0.12 + 0.14 + 0.1 + 0.1 + 0.2 + 0.2 = 0.86 at 20p = 17.2p.
    expect(q.energyP).toBeCloseTo(17.2, 6);
    // Raw kWh (0.87) would give 17.4 — banker's rounding must be applied.
    expect(q.energyP).not.toBeCloseTo(17.4, 6);
    expect(q.isCurrent).toBe(false);
    expect(q.displayName).toBe("Candidate Full");
    expect(q.productCode).toBe("CANDA");
  });

  it("accrues the candidate standing charge once per local day in range", () => {
    // 3 days x 40p, including the consumption-free third day.
    expect(quote(CAND_FULL).standingP).toBeCloseTo(120.0, 6);
    expect(quote(CAND_FULL).totalP).toBeCloseTo(137.2, 6);
    expect(quote(CAND_PART).standingP).toBeCloseTo(30.0, 6);
    expect(quote(CAND_GAS).standingP).toBeCloseTo(75.0, 6);
  });

  it("reports partial rate coverage and prices only the covered intervals", () => {
    const q = quote(CAND_PART);
    // Rates cover day 1 only: 4 of 6 elec intervals.
    expect(q.coveragePct).toBeCloseTo((4 / 6) * 100, 6);
    // Day-1 billed kWh 0.46 at the 5p DIRECT_DEBIT row (not the 99p decoy).
    expect(q.energyP).toBeCloseTo(2.3, 6);
    expect(q.totalP).toBeCloseTo(32.3, 6);
    expect(quote(CAND_FULL).coveragePct).toBeCloseTo(100, 6);
  });

  it("orders quotes electricity before gas, cheapest first, current included", () => {
    // Elec: part 32.3 < full 137.2 < current 201.5. Gas: cand 85 < current 102.
    expect(response.quotes.map((q) => q.tariffCode)).toEqual([
      CAND_PART,
      CAND_FULL,
      CUR_ELEC,
      CAND_GAS,
      CUR_GAS,
    ]);
    expect(response.quotes.map((q) => q.isCurrent)).toEqual([false, false, true, false, true]);
  });

  it("reports current-tariff rows equal to the daily_costs sums", () => {
    const sums = getDb()
      .prepare(
        `SELECT meter_point_id AS id, SUM(energy_p) AS energyP,
                SUM(standing_p) AS standingP, SUM(total_p) AS totalP
           FROM daily_costs WHERE local_date >= ? AND local_date <= ?
          GROUP BY meter_point_id`
      )
      .all(FROM, TO) as { id: number; energyP: number; standingP: number; totalP: number }[];
    const byId = new Map(sums.map((s) => [s.id, s]));

    const elec = quote(CUR_ELEC);
    expect(elec.isCurrent).toBe(true);
    expect(elec.energyP).toBeCloseTo(byId.get(1)!.energyP, 9);
    expect(elec.standingP).toBeCloseTo(byId.get(1)!.standingP, 9);
    expect(elec.totalP).toBeCloseTo(byId.get(1)!.totalP, 9);
    // Sanity: billed 0.86 kWh x 25p + 3 x 60p standing.
    expect(elec.energyP).toBeCloseTo(21.5, 6);
    expect(elec.totalP).toBeCloseTo(201.5, 6);
    expect(elec.coveragePct).toBeCloseTo(100, 6);

    const gas = quote(CUR_GAS);
    expect(gas.energyP).toBeCloseTo(byId.get(2)!.energyP, 9);
    expect(gas.standingP).toBeCloseTo(byId.get(2)!.standingP, 9);
    expect(gas.totalP).toBeCloseTo(byId.get(2)!.totalP, 9);
    expect(gas.totalP).toBeCloseTo(102.0, 6);
  });
});

// Runs AFTER the seeded-candidate assertions above (`response` is already
// captured); overwrites sync_state with the mock candidates.
describe("syncCompareCandidates (mock mode, end to end)", () => {
  const AGILE = "E-1R-AGILE-24-10-01-A"; // region A from the seeded agreements
  const ANCHOR = "2026-01-15T00:00:00Z"; // oldest consumption interval seeded

  it("discovers the fixed mock candidates and stores their rates", async () => {
    await syncCompareCandidates();

    expect(JSON.parse(getState("compare_candidates")!)).toEqual([
      {
        productCode: "AGILE-24-10-01",
        displayName: "Agile Octopus",
        fuel: "electricity",
        tariffCode: AGILE,
      },
      {
        productCode: "SILVER-25-04-01",
        displayName: "Octopus Tracker",
        fuel: "electricity",
        tariffCode: "E-1R-SILVER-25-04-01-A",
      },
      {
        productCode: "SILVER-25-04-01",
        displayName: "Octopus Tracker",
        fuel: "gas",
        tariffCode: "G-1R-SILVER-25-04-01-A",
      },
    ]);
    expect(getState("compare_candidates_synced_at")).not.toBeNull();
    expect(getState(`rates_synced_through:${AGILE}|${ANCHOR}`)).not.toBeNull();
  });

  it("stores Agile-shaped half-hourly rates from the oldest consumption on", () => {
    const db = getDb();
    const dayCount = db
      .prepare(
        `SELECT COUNT(*) AS n FROM unit_rates
          WHERE tariff_code = ? AND valid_from >= ? AND valid_from < ?`
      )
      .get(AGILE, "2026-01-15T00:00:00Z", "2026-01-16T00:00:00Z") as { n: number };
    expect(dayCount.n).toBe(48); // plain GMT day

    const rateAt = (validFrom: string): number =>
      (
        db
          .prepare("SELECT p_inc_vat AS p FROM unit_rates WHERE tariff_code = ? AND valid_from = ?")
          .get(AGILE, validFrom) as { p: number }
      ).p;
    expect(rateAt("2026-01-15T17:30:00Z")).toBeGreaterThan(27); // evening peak ~32p
    expect(rateAt("2026-01-15T03:30:00Z")).toBeLessThan(14); // overnight trough ~11p

    // Tracker: one flat rate per local day, elec ~22.1p / gas ~5.4p.
    const tracker = db
      .prepare(
        `SELECT p_inc_vat AS p FROM unit_rates
          WHERE tariff_code = ? AND valid_from = ? AND valid_to = ?`
      )
      .get("G-1R-SILVER-25-04-01-A", "2026-01-15T00:00:00Z", "2026-01-16T00:00:00Z") as
      | { p: number }
      | undefined;
    expect(tracker).toBeDefined();
    expect(tracker!.p).toBeGreaterThan(4.9);
    expect(tracker!.p).toBeLessThan(5.9);
  });

  it("prices the mock candidates against stored consumption with full coverage", async () => {
    const after = getComparison(FROM, TO);
    const agile = after.quotes.find((q) => q.tariffCode === AGILE);
    expect(agile).toBeDefined();
    expect(agile!.coveragePct).toBeCloseTo(100, 6);
    expect(agile!.energyP).toBeGreaterThan(0);
    expect(agile!.standingP).toBeCloseTo(3 * 47.6, 6);
    const silverGas = after.quotes.find((q) => q.tariffCode === "G-1R-SILVER-25-04-01-A");
    expect(silverGas!.coveragePct).toBeCloseTo(100, 6);
    expect(silverGas!.standingP).toBeCloseTo(3 * 27.5, 6);

    // Second sync is incremental (watermark) and idempotent (upserts).
    const countRows = (): number =>
      (getDb().prepare("SELECT COUNT(*) AS n FROM unit_rates WHERE tariff_code = ?").get(AGILE) as {
        n: number;
      }).n;
    const before = countRows();
    await syncCompareCandidates();
    expect(countRows()).toBe(before);
  });
});
