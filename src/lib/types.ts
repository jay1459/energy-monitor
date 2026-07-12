/**
 * Shared domain types and API contracts.
 *
 * Conventions used throughout the app:
 * - All instants are UTC ISO-8601 strings with a trailing `Z` and second
 *   precision, e.g. "2026-07-08T14:30:00Z". These sort lexicographically.
 * - Local calendar dates (Europe/London) are "yyyy-MM-dd" strings.
 * - Money is pence (inc VAT unless a field says otherwise), energy is kWh.
 *   Gas raw readings may be m³ (SMETS2); the normalized `kwh` column is
 *   always kWh.
 */

export type Fuel = "electricity" | "gas";

export type GasUnit = "kwh" | "m3";

// ---------------------------------------------------------------------------
// Persisted domain rows (mirror the SQLite schema in lib/db.ts)
// ---------------------------------------------------------------------------

export interface MeterPoint {
  id: number;
  fuel: Fuel;
  /** MPAN (electricity) or MPRN (gas). */
  identifier: string;
  isExport: boolean;
  /** Unit of raw consumption values for this meter point. */
  unit: GasUnit;
  activeSerial: string | null;
  label: string | null;
}

export interface Agreement {
  meterPointId: number;
  tariffCode: string;
  /** Derived from the tariff code (strip `E-1R-`/`G-1R-` prefix and `-X` region suffix). */
  productCode: string;
  validFrom: string;
  validTo: string | null;
}

export interface ConsumptionRow {
  meterPointId: number;
  intervalStart: string;
  intervalEnd: string;
  /** As returned by the API (kWh, or m³ for SMETS2 gas). */
  valueRaw: number;
  /** Normalized kWh. */
  kwh: number;
  fetchedAt: string;
  revisedAt: string | null;
}

export type RateType = "standard" | "day" | "night";

export interface UnitRateRow {
  tariffCode: string;
  rateType: RateType;
  /** "DIRECT_DEBIT", "NON_DIRECT_DEBIT", or "" when the API returns null. */
  paymentMethod: string;
  validFrom: string;
  validTo: string | null;
  pExcVat: number;
  pIncVat: number;
}

export interface StandingChargeRow {
  tariffCode: string;
  paymentMethod: string;
  validFrom: string;
  validTo: string | null;
  pExcVat: number;
  pIncVat: number;
}

export interface TelemetryDbRow {
  deviceId: string;
  readAt: string;
  demandW: number | null;
  /** Cumulative meter register, Wh. */
  consumptionWh: number | null;
  exportWh: number | null;
  /** Wh consumed between this reading and the next. */
  consumptionDeltaWh: number | null;
  costDeltaP: number | null;
}

export interface DailyCostDbRow {
  meterPointId: number;
  localDate: string;
  kwh: number;
  intervalsPresent: number;
  intervalsExpected: number;
  /** Energy cost in pence inc VAT. For export meter points this is earnings. */
  energyP: number;
  standingP: number;
  totalP: number;
  computedAt: string;
}

// ---------------------------------------------------------------------------
// Data-source DTOs (returned by EnergyDataSource implementations)
// ---------------------------------------------------------------------------

export interface AccountAgreementDto {
  tariffCode: string;
  validFrom: string;
  validTo: string | null;
}

export interface AccountMeterPointDto {
  fuel: Fuel;
  identifier: string;
  isExport: boolean;
  /** All serials ever attached — history may live under old serials. */
  serials: string[];
  agreements: AccountAgreementDto[];
}

export interface AccountInfoDto {
  accountNumber: string;
  meterPoints: AccountMeterPointDto[];
}

export interface ConsumptionReadingDto {
  intervalStart: string;
  intervalEnd: string;
  /** Raw API units (kWh, or m³ for SMETS2 gas). */
  value: number;
}

export interface RateDto {
  validFrom: string;
  validTo: string | null;
  pExcVat: number;
  pIncVat: number;
  paymentMethod: string | null;
}

export type TelemetryGrouping =
  | "TEN_SECONDS"
  | "ONE_MINUTE"
  | "FIVE_MINUTES"
  | "HALF_HOURLY"
  | "HOURLY";

export interface TelemetryReadingDto {
  readAt: string;
  demandW: number | null;
  consumptionWh: number | null;
  exportWh: number | null;
  consumptionDeltaWh: number | null;
  costDeltaP: number | null;
}

// ---------------------------------------------------------------------------
// HTTP API contracts (implemented in src/app/api/*, consumed by the UI)
// ---------------------------------------------------------------------------

export type AppMode = "live" | "mock" | "setup";

export interface MeterStatus {
  meterPointId: number;
  fuel: Fuel;
  isExport: boolean;
  label: string;
  tariffCode: string | null;
  /** UTC ISO of the newest stored half-hour's end, or null if no data. */
  latestIntervalEnd: string | null;
  /** Most recent Europe/London date for which every expected half-hour is stored. */
  completeThroughLocalDate: string | null;
}

export interface StatusResponse {
  mode: AppMode;
  meters: MeterStatus[];
  telemetryAvailable: boolean;
  generatedAt: string;
}

export type Resolution = "halfhour" | "day" | "week" | "month";

export interface UsagePoint {
  /**
   * Bucket key: UTC ISO interval start for "halfhour";
   * local date "yyyy-MM-dd" for "day"; first local date of the bucket
   * for "week"/"month".
   */
  t: string;
  kwh: number;
  /** Pence inc VAT (energy only, no standing charge); null when no rate is known. */
  costP: number | null;
}

export interface UsageResponse {
  fuel: Fuel;
  isExport: boolean;
  resolution: Resolution;
  /** Requested local-date range, inclusive. */
  from: string;
  to: string;
  points: UsagePoint[];
}

export interface DailyCostApiRow {
  date: string;
  fuel: Fuel;
  isExport: boolean;
  kwh: number;
  energyP: number;
  standingP: number;
  totalP: number;
  complete: boolean;
}

export interface CostsResponse {
  from: string;
  to: string;
  days: DailyCostApiRow[];
  totals: {
    /** Import cost inc standing charges, pence. */
    importP: number;
    /** Export earnings, pence (positive number). */
    exportP: number;
    /** importP - exportP. */
    netP: number;
  };
}

export interface SummaryTile {
  kwh: number;
  costP: number;
  complete: boolean;
}

export interface SummaryResponse {
  /** Keyed by "electricity" | "gas" | "export"; missing key = meter absent. */
  yesterday: Partial<Record<"electricity" | "gas" | "export", SummaryTile>>;
  /** Calendar month to date (only complete days included). */
  monthToDate: {
    importP: number;
    exportP: number;
    netP: number;
    importKwh: number;
  };
  /**
   * Projected calendar-month net cost: month-to-date plus the recent average
   * daily net for the remaining days. Null until a complete day exists.
   */
  projection: {
    monthEndNetP: number;
    avgDailyNetP: number;
    /** Complete days the average was taken over (up to 14). */
    basisDays: number;
  } | null;
  /** Latest local date with complete data across import meters. */
  completeThroughLocalDate: string | null;
  generatedAt: string;
}

export interface LiveResponse {
  available: boolean;
  readAt?: string;
  demandW?: number;
  /** kWh consumed so far today (Europe/London), from telemetry deltas. */
  todayKwh?: number;
  todayCostP?: number;
}

export interface RateSummary {
  fuel: Fuel;
  isExport: boolean;
  tariffCode: string | null;
  /** Current standard unit rate, pence/kWh inc VAT. */
  unitRatePIncVat: number | null;
  /** Current standing charge, pence/day inc VAT. Zero for export. */
  standingPIncVat: number | null;
}

export interface RatesResponse {
  rates: RateSummary[];
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Insights (/api/insights)
// ---------------------------------------------------------------------------

export interface HeatmapDay {
  date: string;
  /**
   * 48 slots indexed by local clock half-hour (00:00 … 23:30). Null = no
   * reading. DST days are folded onto the 48-slot clock: the repeated hour
   * on the 50-half-hour day is summed, the missing hour on the 46-half-hour
   * day stays null.
   */
  kwh: (number | null)[];
}

export interface InsightsResponse {
  fuel: Fuel;
  heatmap: {
    /** Local-date range covered, inclusive (up to 8 weeks, oldest first). */
    from: string;
    to: string;
    days: HeatmapDay[];
    /** Largest cell value — the UI's color-scale max. */
    maxKwh: number;
  };
  /**
   * Always-on draw, estimated as the median overnight (01:00–05:00 local)
   * half-hour over the last 28 complete days. Null until enough data.
   */
  baseload: {
    watts: number | null;
    /** That draw priced at the current unit rate for a full year. */
    annualCostP: number | null;
    sampleDays: number;
  };
  weekCompare: {
    /** Mon..Sun. Null = that day has no (complete) data. */
    days: { weekday: string; thisWeekKwh: number | null; lastWeekKwh: number | null }[];
    thisWeekTotalKwh: number;
    lastWeekTotalKwh: number;
    /**
     * Like-for-like: computed over weekdays complete in BOTH weeks ("vs the
     * same days last week"); null when no matched days (or matched last-week
     * usage is 0). The totals above remain whole-week sums for display.
     */
    deltaPct: number | null;
  };
  /** Highest-usage half-hours of the last 30 days, descending. */
  peaks: { intervalStart: string; kwh: number; costP: number | null }[];
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Tariff comparison (/api/compare)
// ---------------------------------------------------------------------------

export interface TariffQuote {
  tariffCode: string;
  productCode: string;
  displayName: string;
  fuel: Fuel;
  /** True for the row reflecting the user's actual tariff. */
  isCurrent: boolean;
  energyP: number;
  standingP: number;
  totalP: number;
  /** % of consumption intervals that had a rate under this tariff (0–100). */
  coveragePct: number;
}

export interface CompareResponse {
  from: string;
  to: string;
  dayCount: number;
  /** One row per (tariff, fuel), current tariffs included, cheapest first per fuel. */
  quotes: TariffQuote[];
  /** When candidate rates were last synced; null before the first sync. */
  candidatesSyncedAt: string | null;
  generatedAt: string;
}

export interface ApiError {
  error: string;
}
