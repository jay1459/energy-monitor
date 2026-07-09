import { normalizeInstant } from "@/lib/time";
import type {
  AccountInfoDto,
  AccountMeterPointDto,
  ConsumptionReadingDto,
  Fuel,
  RateDto,
  RateType,
} from "@/lib/types";

/**
 * Octopus Energy REST client (api.octopus.energy/v1).
 *
 * - Consumption + account endpoints need HTTP Basic auth: API key as
 *   username, blank password. Product/rate endpoints are public.
 * - Responses paginate via {count, next, previous, results}; we always
 *   follow `next`.
 * - The API emits timestamps with mixed offsets (Z and +01:00) across DST
 *   boundaries; everything is normalized to canonical UTC here so nothing
 *   downstream ever sees a non-UTC instant.
 * - Undocumented rate limit (~100 calls/hour shared account-wide): retry
 *   429/5xx with exponential backoff and give up rather than hammer.
 */

const BASE = "https://api.octopus.energy/v1";
const MAX_RETRIES = 4;

export class OctopusRestError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly url: string
  ) {
    super(message);
    this.name = "OctopusRestError";
  }
}

interface Paginated<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class OctopusRestClient {
  constructor(private readonly apiKey: string | null) {}

  private authHeaders(): Record<string, string> {
    if (!this.apiKey) return {};
    return {
      Authorization: `Basic ${Buffer.from(`${this.apiKey}:`).toString("base64")}`,
    };
  }

  private async getJson<T>(url: string, authenticated: boolean): Promise<T> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        // 2s, 4s, 8s, 16s with jitter
        await sleep(2000 * 2 ** (attempt - 1) * (0.75 + Math.random() * 0.5));
      }
      let res: Response;
      try {
        res = await fetch(url, {
          headers: authenticated ? this.authHeaders() : {},
          signal: AbortSignal.timeout(30_000),
        });
      } catch (err) {
        lastError = err;
        continue; // network error — retry
      }
      if (res.ok) {
        return (await res.json()) as T;
      }
      if (res.status === 401 || res.status === 403) {
        throw new OctopusRestError(
          `authentication failed (${res.status}) — check OCTOPUS_API_KEY`,
          res.status,
          url
        );
      }
      if (res.status === 404) {
        throw new OctopusRestError(`not found (404)`, 404, url);
      }
      if (res.status === 429 || res.status >= 500) {
        lastError = new OctopusRestError(
          `HTTP ${res.status}${res.status === 429 ? " (rate limited)" : ""}`,
          res.status,
          url
        );
        continue; // retry
      }
      throw new OctopusRestError(`HTTP ${res.status}`, res.status, url);
    }
    throw lastError instanceof Error
      ? lastError
      : new OctopusRestError("request failed after retries", null, url);
  }

  /** Follow pagination until exhausted. */
  private async getAllPages<T>(firstUrl: string, authenticated: boolean): Promise<T[]> {
    const out: T[] = [];
    let url: string | null = firstUrl;
    while (url) {
      const page: Paginated<T> = await this.getJson<Paginated<T>>(url, authenticated);
      out.push(...page.results);
      url = page.next;
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Account (authenticated)
  // -------------------------------------------------------------------------

  async getAccount(accountNumber: string): Promise<AccountInfoDto> {
    interface ApiAgreement {
      tariff_code: string;
      valid_from: string;
      valid_to: string | null;
    }
    interface ApiMeter {
      serial_number: string;
    }
    interface ApiElecMp {
      mpan: string;
      is_export?: boolean;
      meters: ApiMeter[];
      agreements: ApiAgreement[];
    }
    interface ApiGasMp {
      mprn: string;
      meters: ApiMeter[];
      agreements: ApiAgreement[];
    }
    interface ApiProperty {
      moved_in_at: string | null;
      moved_out_at: string | null;
      electricity_meter_points: ApiElecMp[];
      gas_meter_points: ApiGasMp[];
    }
    interface ApiAccount {
      number: string;
      properties: ApiProperty[];
    }

    const data = await this.getJson<ApiAccount>(
      `${BASE}/accounts/${encodeURIComponent(accountNumber)}/`,
      true
    );

    // Only the current property — ex-homes still list meter points.
    const current = data.properties.filter((p) => !p.moved_out_at);
    const meterPoints: AccountMeterPointDto[] = [];
    for (const prop of current) {
      for (const mp of prop.electricity_meter_points ?? []) {
        meterPoints.push({
          fuel: "electricity",
          identifier: mp.mpan,
          isExport: mp.is_export ?? false,
          serials: (mp.meters ?? []).map((m) => m.serial_number).filter(Boolean),
          agreements: (mp.agreements ?? []).map((a) => ({
            tariffCode: a.tariff_code,
            validFrom: normalizeInstant(a.valid_from),
            validTo: a.valid_to ? normalizeInstant(a.valid_to) : null,
          })),
        });
      }
      for (const mp of prop.gas_meter_points ?? []) {
        meterPoints.push({
          fuel: "gas",
          identifier: mp.mprn,
          isExport: false,
          serials: (mp.meters ?? []).map((m) => m.serial_number).filter(Boolean),
          agreements: (mp.agreements ?? []).map((a) => ({
            tariffCode: a.tariff_code,
            validFrom: normalizeInstant(a.valid_from),
            validTo: a.valid_to ? normalizeInstant(a.valid_to) : null,
          })),
        });
      }
    }
    return { accountNumber: data.number, meterPoints };
  }

  // -------------------------------------------------------------------------
  // Consumption (authenticated)
  // -------------------------------------------------------------------------

  /**
   * Half-hourly consumption for [fromUtc, toUtc). Returns rows in
   * chronological order with canonical UTC timestamps. An unknown serial
   * returns HTTP 200 with zero rows — the caller decides what that means.
   */
  async getConsumption(
    fuel: Fuel,
    identifier: string,
    serial: string,
    fromUtc: string,
    toUtc: string
  ): Promise<ConsumptionReadingDto[]> {
    interface ApiReading {
      consumption: number;
      interval_start: string;
      interval_end: string;
    }
    const kind = fuel === "electricity" ? "electricity-meter-points" : "gas-meter-points";
    const url =
      `${BASE}/${kind}/${encodeURIComponent(identifier)}/meters/` +
      `${encodeURIComponent(serial)}/consumption/` +
      `?order_by=period&page_size=25000` +
      `&period_from=${encodeURIComponent(fromUtc)}&period_to=${encodeURIComponent(toUtc)}`;
    const rows = await this.getAllPages<ApiReading>(url, true);
    return rows.map((r) => ({
      intervalStart: normalizeInstant(r.interval_start),
      intervalEnd: normalizeInstant(r.interval_end),
      value: r.consumption,
    }));
  }

  // -------------------------------------------------------------------------
  // Rates (public)
  // -------------------------------------------------------------------------

  private rateUrl(
    productCode: string,
    tariffCode: string,
    fuel: Fuel,
    endpoint: "standard-unit-rates" | "day-unit-rates" | "night-unit-rates" | "standing-charges",
    fromUtc: string,
    toUtc: string
  ): string {
    const kind = fuel === "electricity" ? "electricity-tariffs" : "gas-tariffs";
    return (
      `${BASE}/products/${encodeURIComponent(productCode)}/${kind}/` +
      `${encodeURIComponent(tariffCode)}/${endpoint}/` +
      `?page_size=1500&period_from=${encodeURIComponent(fromUtc)}&period_to=${encodeURIComponent(toUtc)}`
    );
  }

  private mapRates(rows: ApiRate[]): RateDto[] {
    return rows.map((r) => ({
      // Export standing charges come back as a single row with null
      // valid_from/valid_to — treat null start as "since forever".
      validFrom: r.valid_from ? normalizeInstant(r.valid_from) : "1970-01-01T00:00:00Z",
      validTo: r.valid_to ? normalizeInstant(r.valid_to) : null,
      pExcVat: r.value_exc_vat,
      pIncVat: r.value_inc_vat,
      paymentMethod: r.payment_method ?? null,
    }));
  }

  async getUnitRates(
    productCode: string,
    tariffCode: string,
    fuel: Fuel,
    rateType: RateType,
    fromUtc: string,
    toUtc: string
  ): Promise<RateDto[]> {
    const endpoint =
      rateType === "standard"
        ? "standard-unit-rates"
        : rateType === "day"
          ? "day-unit-rates"
          : "night-unit-rates";
    const rows = await this.getAllPages<ApiRate>(
      this.rateUrl(productCode, tariffCode, fuel, endpoint, fromUtc, toUtc),
      false
    );
    return this.mapRates(rows);
  }

  async getStandingCharges(
    productCode: string,
    tariffCode: string,
    fuel: Fuel,
    fromUtc: string,
    toUtc: string
  ): Promise<RateDto[]> {
    const rows = await this.getAllPages<ApiRate>(
      this.rateUrl(productCode, tariffCode, fuel, "standing-charges", fromUtc, toUtc),
      false
    );
    return this.mapRates(rows);
  }
}

interface ApiRate {
  value_exc_vat: number;
  value_inc_vat: number;
  valid_from: string | null;
  valid_to: string | null;
  payment_method: string | null;
}

/**
 * Product code from a tariff code: strip the `<E|G>-<1R|2R|…>-` prefix and
 * the trailing `-<region letter>`. Product codes contain hyphens, so naive
 * splitting breaks: E-1R-AGILE-24-10-01-C → AGILE-24-10-01.
 */
export function productCodeFromTariff(tariffCode: string): string {
  const match = /^[EG]-[0-9A-Z]+R-(.+)-[A-P]$/.exec(tariffCode);
  if (!match) {
    throw new Error(`unrecognized tariff code format: ${tariffCode}`);
  }
  return match[1];
}
