import { getConfig } from "@/lib/config";
import { OctopusGraphqlClient } from "@/lib/octopus/graphql";
import { OctopusRestClient, productCodeFromTariff } from "@/lib/octopus/rest";
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
 * The collector talks to this interface, never to HTTP clients directly.
 * `OctopusSource` is the real thing; `MockSource` (mock.ts) generates
 * deterministic synthetic data for demos, development, and tests.
 */
export interface EnergyDataSource {
  readonly kind: "live" | "mock";
  getAccount(): Promise<AccountInfoDto>;
  /** Half-hourly readings for [fromUtc, toUtc), chronological, UTC-normalized. */
  getConsumption(
    fuel: Fuel,
    identifier: string,
    serial: string,
    fromUtc: string,
    toUtc: string
  ): Promise<ConsumptionReadingDto[]>;
  getUnitRates(
    productCode: string,
    tariffCode: string,
    fuel: Fuel,
    rateType: RateType,
    fromUtc: string,
    toUtc: string
  ): Promise<RateDto[]>;
  getStandingCharges(
    productCode: string,
    tariffCode: string,
    fuel: Fuel,
    fromUtc: string,
    toUtc: string
  ): Promise<RateDto[]>;
  /** Empty when no Home Mini is registered. */
  getTelemetryDeviceIds(): Promise<string[]>;
  getTelemetry(
    deviceId: string,
    startUtc: string,
    endUtc: string,
    grouping: TelemetryGrouping
  ): Promise<TelemetryReadingDto[]>;
}

class OctopusSource implements EnergyDataSource {
  readonly kind = "live" as const;
  private readonly rest: OctopusRestClient;
  private graphql: OctopusGraphqlClient | null = null;

  constructor(
    private readonly apiKey: string,
    private readonly accountNumber: string
  ) {
    this.rest = new OctopusRestClient(apiKey);
  }

  private gql(): OctopusGraphqlClient {
    if (!this.graphql) this.graphql = new OctopusGraphqlClient(this.apiKey);
    return this.graphql;
  }

  getAccount(): Promise<AccountInfoDto> {
    return this.rest.getAccount(this.accountNumber);
  }

  getConsumption(
    fuel: Fuel,
    identifier: string,
    serial: string,
    fromUtc: string,
    toUtc: string
  ): Promise<ConsumptionReadingDto[]> {
    return this.rest.getConsumption(fuel, identifier, serial, fromUtc, toUtc);
  }

  getUnitRates(
    productCode: string,
    tariffCode: string,
    fuel: Fuel,
    rateType: RateType,
    fromUtc: string,
    toUtc: string
  ): Promise<RateDto[]> {
    return this.rest.getUnitRates(productCode, tariffCode, fuel, rateType, fromUtc, toUtc);
  }

  getStandingCharges(
    productCode: string,
    tariffCode: string,
    fuel: Fuel,
    fromUtc: string,
    toUtc: string
  ): Promise<RateDto[]> {
    return this.rest.getStandingCharges(productCode, tariffCode, fuel, fromUtc, toUtc);
  }

  async getTelemetryDeviceIds(): Promise<string[]> {
    const config = getConfig();
    if (config.homeMiniDeviceId) return [config.homeMiniDeviceId];
    // Failures propagate: "discovery errored" and "no Home Mini" must stay
    // distinguishable, or a transient 429 would cache an empty device list.
    return this.gql().getSmartDeviceIds(this.accountNumber);
  }

  getTelemetry(
    deviceId: string,
    startUtc: string,
    endUtc: string,
    grouping: TelemetryGrouping
  ): Promise<TelemetryReadingDto[]> {
    return this.gql().getTelemetry(deviceId, startUtc, endUtc, grouping);
  }
}

let cached: EnergyDataSource | null = null;

/** The app-wide data source, chosen by config mode. Throws in setup mode. */
export async function getDataSource(): Promise<EnergyDataSource> {
  if (cached) return cached;
  const config = getConfig();
  if (config.mode === "mock") {
    const { MockSource } = await import("@/lib/octopus/mock");
    cached = new MockSource();
  } else if (config.mode === "live") {
    cached = new OctopusSource(config.apiKey!, config.accountNumber!);
  } else {
    throw new Error(
      "no data source in setup mode — set OCTOPUS_API_KEY and OCTOPUS_ACCOUNT_NUMBER, or ENERGY_MOCK=1"
    );
  }
  return cached;
}

export { productCodeFromTariff };
