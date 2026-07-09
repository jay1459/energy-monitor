import { describe, expect, it } from "vitest";
import {
  findRateAt,
  halfHourCostP,
  resolveUnitRate,
  roundKwhForBilling,
} from "@/lib/costs";
import type { UnitRateRow } from "@/lib/types";

function rate(overrides: Partial<UnitRateRow>): UnitRateRow {
  return {
    tariffCode: "E-1R-TEST-A",
    rateType: "standard",
    paymentMethod: "",
    validFrom: "2025-01-01T00:00:00Z",
    validTo: null,
    pExcVat: 20,
    pIncVat: 21,
    ...overrides,
  };
}

describe("roundKwhForBilling", () => {
  it("rounds exact halves to the even hundredth", () => {
    expect(roundKwhForBilling(0.005)).toBe(0.0);
    expect(roundKwhForBilling(0.015)).toBe(0.02);
    expect(roundKwhForBilling(0.025)).toBe(0.02);
    expect(roundKwhForBilling(0.125)).toBe(0.12);
    expect(roundKwhForBilling(0.135)).toBe(0.14);
    expect(roundKwhForBilling(0.045)).toBe(0.04);
    expect(roundKwhForBilling(2.675)).toBe(2.68);
  });

  it("detects halves despite float error in both directions", () => {
    // 1.005 * 100 === 100.49999999999999, 0.135 * 100 === 13.500000000000002
    expect(roundKwhForBilling(1.005)).toBe(1.0);
    expect(roundKwhForBilling(0.135)).toBe(0.14);
  });

  it("rounds non-halves to the nearest hundredth", () => {
    expect(roundKwhForBilling(0.1349)).toBe(0.13);
    expect(roundKwhForBilling(0.1351)).toBe(0.14);
    expect(roundKwhForBilling(0.126)).toBe(0.13);
    expect(roundKwhForBilling(0.124)).toBe(0.12);
    expect(roundKwhForBilling(0)).toBe(0);
    expect(roundKwhForBilling(1.23)).toBe(1.23);
    expect(roundKwhForBilling(4.999)).toBe(5.0);
  });
});

describe("findRateAt", () => {
  const early = rate({
    validFrom: "2025-01-01T00:00:00Z",
    validTo: "2025-06-01T00:00:00Z",
    pIncVat: 10,
  });
  const late = rate({ validFrom: "2025-06-01T00:00:00Z", validTo: null, pIncVat: 20 });
  const unordered = [late, early];

  it("treats validFrom as inclusive and validTo as exclusive", () => {
    expect(findRateAt(unordered, "2025-01-01T00:00:00Z")?.pIncVat).toBe(10);
    expect(findRateAt(unordered, "2025-05-31T23:59:59Z")?.pIncVat).toBe(10);
    expect(findRateAt(unordered, "2025-06-01T00:00:00Z")?.pIncVat).toBe(20);
  });

  it("handles open-ended rows and misses", () => {
    expect(findRateAt(unordered, "2030-01-01T00:00:00Z")?.pIncVat).toBe(20);
    expect(findRateAt(unordered, "2024-12-31T23:59:59Z")).toBeNull();
    expect(findRateAt([], "2025-01-01T00:00:00Z")).toBeNull();
  });

  it("picks the latest validFrom when rows overlap", () => {
    const a = rate({ validFrom: "2025-01-01T00:00:00Z", validTo: null, pIncVat: 10 });
    const b = rate({ validFrom: "2025-03-01T00:00:00Z", validTo: null, pIncVat: 20 });
    expect(findRateAt([b, a], "2025-04-01T00:00:00Z")?.pIncVat).toBe(20);
    expect(findRateAt([b, a], "2025-02-01T00:00:00Z")?.pIncVat).toBe(10);
  });
});

describe("halfHourCostP", () => {
  it("bills the rounded kWh, not the raw value", () => {
    expect(halfHourCostP(0.135, 30)).toBeCloseTo(0.14 * 30, 9);
    expect(halfHourCostP(0.125, 30)).toBeCloseTo(0.12 * 30, 9);
    expect(halfHourCostP(0, 30)).toBe(0);
  });
});

describe("resolveUnitRate", () => {
  it("prefers the exact payment-method row, falling back to ''", () => {
    const rows = [
      rate({ paymentMethod: "DIRECT_DEBIT", pIncVat: 25 }),
      rate({ paymentMethod: "", pIncVat: 26 }),
    ];
    expect(resolveUnitRate(rows, "2025-02-01T12:00:00Z", "DIRECT_DEBIT")?.pIncVat).toBe(25);
    expect(resolveUnitRate(rows, "2025-02-01T12:00:00Z", "NON_DIRECT_DEBIT")?.pIncVat).toBe(
      26
    );
  });

  it("uses standard rows whenever any exist", () => {
    const rows = [
      rate({ rateType: "standard", pIncVat: 24 }),
      rate({ rateType: "day", pIncVat: 30 }),
      rate({ rateType: "night", pIncVat: 10 }),
    ];
    expect(resolveUnitRate(rows, "2025-02-01T03:00:00Z", "DIRECT_DEBIT")?.pIncVat).toBe(24);
  });

  it("prices day/night-only tariffs by the [00:30,07:30) UTC night window", () => {
    const rows = [
      rate({ rateType: "day", pIncVat: 30 }),
      rate({ rateType: "night", pIncVat: 10 }),
    ];
    const at = (iso: string) => resolveUnitRate(rows, iso, "DIRECT_DEBIT")?.pIncVat;
    expect(at("2025-02-01T00:00:00Z")).toBe(30); // before night starts
    expect(at("2025-02-01T00:30:00Z")).toBe(10); // night start inclusive
    expect(at("2025-02-01T03:00:00Z")).toBe(10);
    expect(at("2025-02-01T07:00:00Z")).toBe(10);
    expect(at("2025-02-01T07:30:00Z")).toBe(30); // night end exclusive
    expect(at("2025-02-01T12:00:00Z")).toBe(30);
  });

  it("returns null when nothing covers the instant", () => {
    const rows = [rate({ validFrom: "2025-06-01T00:00:00Z" })];
    expect(resolveUnitRate(rows, "2025-01-01T00:00:00Z", "DIRECT_DEBIT")).toBeNull();
    expect(resolveUnitRate([], "2025-01-01T00:00:00Z", "DIRECT_DEBIT")).toBeNull();
  });
});
