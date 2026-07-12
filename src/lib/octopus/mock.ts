import { DateTime } from "luxon";
import {
  addLocalDays,
  LONDON,
  localDayBoundsUtc,
  localDayOf,
  parseInstant,
  todayLocal,
  utcIso,
} from "@/lib/time";
import type { EnergyDataSource } from "@/lib/octopus/source";
import type {
  AccountInfoDto,
  ConsumptionReadingDto,
  Fuel,
  RateDto,
  RateType,
  TelemetryGrouping,
  TelemetryReadingDto,
} from "@/lib/types";

/**
 * Deterministic synthetic household. Faithful to the real API's sharp
 * edges so the pipeline is exercised honestly:
 * - gas arrives in m³ (SMETS2) and needs calorific conversion,
 * - variable-tariff rates come in DIRECT_DEBIT and NON_DIRECT_DEBIT
 *   duplicates that must be filtered,
 * - export rates have no VAT split and a zero standing charge,
 * - consumption is only available through the end of yesterday
 *   (Europe/London), like the real day-late feed,
 * - telemetry is the only "today" signal.
 *
 * Values are a pure function of the interval timestamp, so any query
 * window returns consistent data.
 *
 * Compare candidates: the collector's mock-mode candidates are the fixed
 * products AGILE-24-10-01 (electricity) and SILVER-25-04-01 (electricity +
 * gas), region C. Any tariff code containing "AGILE" gets deterministic
 * half-hourly Agile-shaped rates; "SILVER" gets one flat Tracker-style rate
 * per Europe/London day. Candidate standing charges are open-ended with
 * identical prices for both payment methods.
 */

export const MOCK_ELEC_IMPORT_MPAN = "1900000000000";
export const MOCK_ELEC_EXPORT_MPAN = "1900000000001";
export const MOCK_GAS_MPRN = "3900000001";
export const MOCK_DEVICE_ID = "00-11-22-FF-FF-33-44-55";

const ELEC_TARIFF = "E-1R-VAR-22-11-01-C";
const GAS_TARIFF = "G-1R-VAR-22-11-01-C";
const EXPORT_TARIFF = "E-1R-OUTGOING-VAR-24-10-26-C";

/** Deterministic 0..1 noise from an integer key (splitmix-style hash). */
function noise(key: number): number {
  let h = (key ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97) >>> 0;
  return ((h ^ (h >>> 15)) >>> 0) / 0xffffffff;
}

/** Smooth per-day factor (e.g. cloud cover), 0..1. */
function dayNoise(localDate: string, salt: number): number {
  const key = Number(localDate.replaceAll("-", "")) + salt * 7919;
  return noise(key);
}

interface LocalTime {
  hour: number; // fractional local hour
  month: number;
  weekend: boolean;
  localDate: string;
}

function localTimeOf(utcInstant: DateTime): LocalTime {
  const local = utcInstant.setZone(LONDON);
  return {
    hour: local.hour + local.minute / 60,
    month: local.month,
    weekend: local.weekday >= 6,
    localDate: local.toISODate()!,
  };
}

/** Winter 1 → summer 0 heating demand factor. */
function seasonFactor(month: number): number {
  // Peaks in January (1), trough in July (7).
  return 0.5 + 0.5 * Math.cos(((month - 1) / 12) * 2 * Math.PI);
}

function bump(hour: number, center: number, width: number): number {
  const d = (hour - center) / width;
  return Math.exp(-d * d);
}

/** Electricity import, kWh per half-hour. */
function elecKwh(t: LocalTime, key: number): number {
  const base = 0.055; // fridge, router, standby
  const morning = 0.28 * bump(t.hour, 7.8, 1.1);
  const daytime = (t.weekend ? 0.16 : 0.07) * bump(t.hour, 13, 3.5);
  const evening = 0.55 * bump(t.hour, 18.7, 1.9);
  const spike = noise(key) > 0.965 ? 0.5 + 0.7 * noise(key + 1) : 0; // kettle/oven
  const jitter = 0.75 + 0.5 * noise(key + 2);
  return Math.round((base + (morning + daytime + evening) * jitter + spike) * 1000) / 1000;
}

/** Gas, m³ per half-hour (SMETS2 units). */
function gasM3(t: LocalTime, key: number): number {
  const season = seasonFactor(t.month);
  const heating =
    season * 0.32 * (bump(t.hour, 7, 1.3) + 0.85 * bump(t.hour, 19, 2.2));
  const hotWater = 0.045 * (bump(t.hour, 7.2, 0.7) + bump(t.hour, 21.5, 0.7));
  const cooking = 0.02 * bump(t.hour, 18.2, 0.8);
  const jitter = 0.7 + 0.6 * noise(key);
  return Math.round((heating + hotWater + cooking) * jitter * 1000) / 1000;
}

/** Solar export, kWh per half-hour. */
function exportKwh(t: LocalTime, key: number): number {
  // Daylight bell; stronger and wider in summer.
  const season = 1 - 0.72 * seasonFactor(t.month);
  const sun = bump(t.hour, 13.1, 2.6 + 1.2 * season);
  const clouds = 0.35 + 0.65 * dayNoise(t.localDate, 3);
  const flicker = 0.85 + 0.3 * noise(key);
  const kwh = 1.35 * season * sun * clouds * flicker;
  return kwh < 0.003 ? 0 : Math.round(kwh * 1000) / 1000;
}

/**
 * Agile-shaped candidate unit rates: one row per half-hour of [fromUtc,
 * toUtc), base ~18p inc VAT with a 16:00–19:00 local peak (~32p) and an
 * overnight trough (~11p), plus seeded noise. exc = inc / 1.05, payment
 * method null like the real Agile feed.
 */
function agileCandidateRates(fromUtc: string, toUtc: string): RateDto[] {
  const from = parseInstant(fromUtc);
  // Floor to the half-hour boundary so the first row covers fromUtc.
  let cursor = from.startOf("hour").plus({ minutes: from.minute >= 30 ? 30 : 0 });
  const end = parseInstant(toUtc);
  const out: RateDto[] = [];
  while (cursor < end) {
    const next = cursor.plus({ minutes: 30 });
    const t = localTimeOf(cursor);
    const key = Math.floor(cursor.toSeconds() / 1800);
    const shaped = 18 + 14 * bump(t.hour, 17.5, 1.1) - 7 * bump(t.hour, 3.5, 2.8);
    const inc = Math.round((shaped + 3 * (noise(key + 101) - 0.5)) * 100) / 100;
    out.push({
      validFrom: utcIso(cursor),
      validTo: utcIso(next),
      pExcVat: Math.round((inc / 1.05) * 100) / 100,
      pIncVat: inc,
      paymentMethod: null,
    });
    cursor = next;
  }
  return out;
}

/**
 * Tracker-shaped candidate unit rates: one flat rate per Europe/London day
 * covering [fromUtc, toUtc) — elec ~22.1p, gas ~5.4p inc VAT with a small
 * seeded daily wobble. exc = inc / 1.05.
 */
function trackerCandidateRates(fuel: Fuel, fromUtc: string, toUtc: string): RateDto[] {
  const base = fuel === "gas" ? 5.4 : 22.1;
  const wobble = fuel === "gas" ? 0.5 : 1.8;
  const out: RateDto[] = [];
  let date = localDayOf(fromUtc);
  for (;;) {
    const { startUtc, endUtc } = localDayBoundsUtc(date);
    if (startUtc >= toUtc) break;
    const inc =
      Math.round((base + wobble * (dayNoise(date, fuel === "gas" ? 23 : 19) - 0.5)) * 100) / 100;
    out.push({
      validFrom: startUtc,
      validTo: endUtc,
      pExcVat: Math.round((inc / 1.05) * 100) / 100,
      pIncVat: inc,
      paymentMethod: null,
    });
    date = addLocalDays(date, 1);
  }
  return out;
}

/** Instantaneous household demand in watts (for telemetry). */
function demandW(instant: DateTime): number {
  const t = localTimeOf(instant);
  const key = Math.floor(instant.toSeconds() / 10);
  const hh = elecKwh(t, Math.floor(instant.toSeconds() / 1800));
  // Scale the half-hour energy to an instantaneous wattage with fast noise.
  const w = hh * 2000 * (0.8 + 0.5 * noise(key));
  return Math.round(Math.max(90, w));
}

export class MockSource implements EnergyDataSource {
  readonly kind = "mock" as const;

  async getAccount(): Promise<AccountInfoDto> {
    const validFrom = "2024-03-01T00:00:00Z";
    return {
      accountNumber: "A-MOCK1234",
      meterPoints: [
        {
          fuel: "electricity",
          identifier: MOCK_ELEC_IMPORT_MPAN,
          isExport: false,
          serials: ["21E1234567"],
          agreements: [{ tariffCode: ELEC_TARIFF, validFrom, validTo: null }],
        },
        {
          fuel: "electricity",
          identifier: MOCK_ELEC_EXPORT_MPAN,
          isExport: true,
          serials: ["21E1234567"],
          agreements: [{ tariffCode: EXPORT_TARIFF, validFrom, validTo: null }],
        },
        {
          fuel: "gas",
          identifier: MOCK_GAS_MPRN,
          isExport: false,
          serials: ["G4A00112233"],
          agreements: [{ tariffCode: GAS_TARIFF, validFrom, validTo: null }],
        },
      ],
    };
  }

  async getConsumption(
    fuel: Fuel,
    identifier: string,
    _serial: string,
    fromUtc: string,
    toUtc: string
  ): Promise<ConsumptionReadingDto[]> {
    // Data exists only through the end of yesterday, Europe/London.
    const availableUntil = DateTime.fromISO(todayLocal(), { zone: LONDON }).startOf("day");
    // Ceil the window start to a UTC half-hour boundary.
    const from = parseInstant(fromUtc);
    const floor = from.startOf("hour").plus({ minutes: Math.floor(from.minute / 30) * 30 });
    let cursor = floor.equals(from.startOf("second")) && from.second === 0 ? floor : floor.plus({ minutes: 30 });
    const end = DateTime.min(parseInstant(toUtc), availableUntil.toUTC());

    const out: ConsumptionReadingDto[] = [];
    while (cursor < end) {
      const next = cursor.plus({ minutes: 30 });
      const t = localTimeOf(cursor);
      const key = Math.floor(cursor.toSeconds() / 1800);
      let value: number;
      if (fuel === "gas") {
        value = gasM3(t, key);
      } else if (identifier === MOCK_ELEC_EXPORT_MPAN) {
        value = exportKwh(t, key);
      } else {
        value = elecKwh(t, key);
      }
      out.push({ intervalStart: utcIso(cursor), intervalEnd: utcIso(next), value });
      cursor = next;
    }
    return out;
  }

  async getUnitRates(
    _productCode: string,
    tariffCode: string,
    fuel: Fuel,
    _rateType: RateType,
    fromUtc: string,
    toUtc: string
  ): Promise<RateDto[]> {
    const from = "2024-01-01T00:00:00Z";
    if (tariffCode === EXPORT_TARIFF) {
      // Export: no VAT distinction, single open-ended row.
      return [{ validFrom: from, validTo: null, pExcVat: 15.0, pIncVat: 15.0, paymentMethod: null }];
    }
    if (tariffCode === GAS_TARIFF) {
      return [
        { validFrom: from, validTo: null, pExcVat: 5.81, pIncVat: 6.1, paymentMethod: "DIRECT_DEBIT" },
        { validFrom: from, validTo: null, pExcVat: 6.29, pIncVat: 6.6, paymentMethod: "NON_DIRECT_DEBIT" },
      ];
    }
    // Compare candidates (see file header) — windowed, unlike the fixed
    // open-ended rows of the household's own tariffs above.
    if (tariffCode.includes("AGILE")) {
      return agileCandidateRates(fromUtc, toUtc);
    }
    if (tariffCode.includes("SILVER")) {
      return trackerCandidateRates(fuel, fromUtc, toUtc);
    }
    // Flexible electricity import — duplicate rows per payment method, like the real API.
    return [
      { validFrom: from, validTo: null, pExcVat: 25.14, pIncVat: 26.4, paymentMethod: "DIRECT_DEBIT" },
      { validFrom: from, validTo: null, pExcVat: 26.57, pIncVat: 27.9, paymentMethod: "NON_DIRECT_DEBIT" },
    ];
  }

  async getStandingCharges(
    _productCode: string,
    tariffCode: string,
    fuel: Fuel,
    _fromUtc: string,
    _toUtc: string
  ): Promise<RateDto[]> {
    const from = "2024-01-01T00:00:00Z";
    if (tariffCode === EXPORT_TARIFF) {
      // Real export standing charges come back as a single zero row with null bounds.
      return [{ validFrom: from, validTo: null, pExcVat: 0, pIncVat: 0, paymentMethod: null }];
    }
    if (tariffCode.includes("AGILE") || tariffCode.includes("SILVER")) {
      // Compare candidates: open-ended, identical for both payment methods.
      const inc = fuel === "gas" ? 27.5 : 47.6;
      const exc = Math.round((inc / 1.05) * 100) / 100;
      return [
        { validFrom: from, validTo: null, pExcVat: exc, pIncVat: inc, paymentMethod: "DIRECT_DEBIT" },
        { validFrom: from, validTo: null, pExcVat: exc, pIncVat: inc, paymentMethod: "NON_DIRECT_DEBIT" },
      ];
    }
    if (tariffCode === GAS_TARIFF) {
      return [
        { validFrom: from, validTo: null, pExcVat: 27.71, pIncVat: 29.1, paymentMethod: "DIRECT_DEBIT" },
        { validFrom: from, validTo: null, pExcVat: 30.0, pIncVat: 31.5, paymentMethod: "NON_DIRECT_DEBIT" },
      ];
    }
    return [
      { validFrom: from, validTo: null, pExcVat: 45.33, pIncVat: 47.6, paymentMethod: "DIRECT_DEBIT" },
      { validFrom: from, validTo: null, pExcVat: 51.62, pIncVat: 54.2, paymentMethod: "NON_DIRECT_DEBIT" },
    ];
  }

  async getTelemetryDeviceIds(): Promise<string[]> {
    return [MOCK_DEVICE_ID];
  }

  async getTelemetry(
    _deviceId: string,
    startUtc: string,
    endUtc: string,
    grouping: TelemetryGrouping
  ): Promise<TelemetryReadingDto[]> {
    const stepSeconds: Record<TelemetryGrouping, number> = {
      TEN_SECONDS: 10,
      ONE_MINUTE: 60,
      FIVE_MINUTES: 300,
      HALF_HOURLY: 1800,
      HOURLY: 3600,
    };
    const step = stepSeconds[grouping];
    const start = parseInstant(startUtc);
    const end = DateTime.min(parseInstant(endUtc), DateTime.utc());
    const out: TelemetryReadingDto[] = [];
    let cursor = start.startOf("second");
    while (cursor < end) {
      const w = demandW(cursor);
      const deltaWh = (w * step) / 3600;
      out.push({
        readAt: utcIso(cursor),
        demandW: w,
        consumptionWh: null, // cumulative register not simulated
        exportWh: null,
        consumptionDeltaWh: Math.round(deltaWh * 100) / 100,
        costDeltaP: Math.round(deltaWh * 0.0264 * 1000) / 1000, // 26.4p/kWh
      });
      cursor = cursor.plus({ seconds: step });
    }
    return out;
  }
}
