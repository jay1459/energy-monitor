import { deleteState, getState, setState } from "@/lib/db";
import { normalizeInstant, nowUtc } from "@/lib/time";
import type { TelemetryGrouping, TelemetryReadingDto } from "@/lib/types";

/**
 * Kraken GraphQL client (api.octopus.energy/v1/graphql/) — used only for
 * what REST cannot do: Home Mini telemetry and smart-device discovery.
 *
 * Token rules (matter more than usual here):
 * - `obtainKrakenToken(input:{APIKey})` returns a JWT valid ~60 min plus a
 *   refresh token. The Authorization header takes the RAW token, no
 *   "Bearer " prefix.
 * - Kraken's dynamic rate limits get progressively stricter and do NOT
 *   auto-reset (KT-CT-1199), so minting a fresh token every poll is the
 *   classic self-inflicted outage. Tokens are cached in sync_state and
 *   survive process restarts; we renew ~5 min before expiry.
 */

const ENDPOINT = "https://api.octopus.energy/v1/graphql/";
const TOKEN_STATE_KEY = "kraken_token";

export class OctopusGraphqlError extends Error {
  constructor(
    message: string,
    public readonly codes: string[] = []
  ) {
    super(message);
    this.name = "OctopusGraphqlError";
  }
}

interface CachedToken {
  token: string;
  /** Unix seconds. */
  expiresAt: number;
  refreshToken: string | null;
  /** Unix seconds. */
  refreshExpiresAt: number | null;
}

interface GraphqlErrorShape {
  message: string;
  extensions?: { errorCode?: string };
}

/** Kraken JWT rejections: KT-CT-1124 expired, KT-CT-1125 invalid. */
function isAuthError(err: OctopusGraphqlError): boolean {
  return (
    err.codes.some((c) => c === "KT-CT-1124" || c === "KT-CT-1125") ||
    /signature has expired|invalid.*token|not authenticated/i.test(err.message)
  );
}

export class OctopusGraphqlClient {
  constructor(private readonly apiKey: string) {}

  private async rawRequest<T>(
    query: string,
    variables: Record<string, unknown>,
    token: string | null
  ): Promise<T> {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Raw JWT — Kraken rejects a "Bearer " prefix.
        ...(token ? { Authorization: token } : {}),
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      throw new OctopusGraphqlError(`GraphQL HTTP ${res.status}`);
    }
    const body = (await res.json()) as { data?: T; errors?: GraphqlErrorShape[] };
    if (body.errors?.length) {
      const codes = body.errors
        .map((e) => e.extensions?.errorCode)
        .filter((c): c is string => Boolean(c));
      throw new OctopusGraphqlError(
        body.errors.map((e) => e.message).join("; "),
        codes
      );
    }
    if (body.data === undefined) {
      throw new OctopusGraphqlError("GraphQL response had no data");
    }
    return body.data;
  }

  private loadCachedToken(): CachedToken | null {
    const raw = getState(TOKEN_STATE_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as CachedToken;
    } catch {
      return null;
    }
  }

  private async obtainToken(): Promise<CachedToken> {
    const cached = this.loadCachedToken();
    const nowSec = Math.floor(nowUtc().toSeconds());

    // Reuse until ~5 minutes before expiry.
    if (cached && cached.expiresAt - nowSec > 300) {
      return cached;
    }

    const mutation = `
      mutation ObtainToken($input: ObtainJSONWebTokenInput!) {
        obtainKrakenToken(input: $input) {
          token
          payload
          refreshToken
          refreshExpiresIn
        }
      }`;

    interface ObtainResult {
      obtainKrakenToken: {
        token: string;
        payload: { exp?: number };
        refreshToken: string | null;
        refreshExpiresIn: number | null;
      };
    }

    // Prefer the refresh token when it is still valid; fall back to the API key.
    let input: Record<string, unknown>;
    if (cached?.refreshToken && cached.refreshExpiresAt && cached.refreshExpiresAt - nowSec > 60) {
      input = { refreshToken: cached.refreshToken };
    } else {
      input = { APIKey: this.apiKey };
    }

    let data: ObtainResult;
    try {
      data = await this.rawRequest<ObtainResult>(mutation, { input }, null);
    } catch (err) {
      // A stale refresh token should not lock us out — retry once with the key.
      if ("refreshToken" in input) {
        data = await this.rawRequest<ObtainResult>(
          mutation,
          { input: { APIKey: this.apiKey } },
          null
        );
      } else {
        throw err;
      }
    }

    const result = data.obtainKrakenToken;
    const token: CachedToken = {
      token: result.token,
      // Read the real expiry from the JWT payload; ~55 min fallback.
      expiresAt: result.payload?.exp ?? nowSec + 55 * 60,
      refreshToken: result.refreshToken,
      refreshExpiresAt: result.refreshExpiresIn,
    };
    setState(TOKEN_STATE_KEY, JSON.stringify(token));
    return token;
  }

  private async request<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const { token } = await this.obtainToken();
    try {
      return await this.rawRequest<T>(query, variables, token);
    } catch (err) {
      // A cached token the server rejects (revoked, expired early, clock
      // skew, mis-derived expiry) would otherwise fail every poll until the
      // local expiresAt runs out — drop it and retry once with a fresh one.
      if (err instanceof OctopusGraphqlError && isAuthError(err)) {
        deleteState(TOKEN_STATE_KEY);
        const fresh = await this.obtainToken();
        return this.rawRequest<T>(query, variables, fresh.token);
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------------

  /** EUI64 device ids of smart devices (ESME/GSME) on active agreements. */
  async getSmartDeviceIds(accountNumber: string): Promise<string[]> {
    const query = `
      query Devices($accountNumber: String!) {
        account(accountNumber: $accountNumber) {
          electricityAgreements(active: true) {
            meterPoint {
              meters(includeInactive: false) {
                smartDevices { deviceId }
              }
            }
          }
        }
      }`;
    interface Result {
      account: {
        electricityAgreements: Array<{
          meterPoint: {
            meters: Array<{ smartDevices: Array<{ deviceId: string }> | null }>;
          } | null;
        }> | null;
      } | null;
    }
    const data = await this.request<Result>(query, { accountNumber });
    const ids = new Set<string>();
    for (const agreement of data.account?.electricityAgreements ?? []) {
      for (const meter of agreement.meterPoint?.meters ?? []) {
        for (const device of meter.smartDevices ?? []) {
          if (device.deviceId) ids.add(device.deviceId);
        }
      }
    }
    return [...ids];
  }

  /**
   * Home Mini telemetry for [startUtc, endUtc). Keep windows small: a full
   * day of TEN_SECONDS is 8,640 rows against a 10,000-node request cap, and
   * retention is a rolling window (KT-GB-4051 "too far in the past").
   */
  async getTelemetry(
    deviceId: string,
    startUtc: string,
    endUtc: string,
    grouping: TelemetryGrouping
  ): Promise<TelemetryReadingDto[]> {
    const query = `
      query Telemetry($deviceId: String!, $start: DateTime!, $end: DateTime!, $grouping: TelemetryGrouping!) {
        smartMeterTelemetry(deviceId: $deviceId, start: $start, end: $end, grouping: $grouping) {
          readAt
          demand
          consumption
          export
          consumptionDelta
          costDeltaWithTax
        }
      }`;
    interface Result {
      smartMeterTelemetry: Array<{
        readAt: string;
        demand: string | number | null;
        consumption: string | number | null;
        export: string | number | null;
        consumptionDelta: string | number | null;
        costDeltaWithTax: string | number | null;
      }> | null;
    }
    const data = await this.request<Result>(query, {
      deviceId,
      start: startUtc,
      end: endUtc,
      grouping,
    });
    const num = (v: string | number | null): number | null =>
      v === null || v === undefined ? null : Number(v);
    return (data.smartMeterTelemetry ?? []).map((r) => ({
      readAt: normalizeInstant(r.readAt),
      demandW: num(r.demand),
      consumptionWh: num(r.consumption),
      exportWh: num(r.export),
      consumptionDeltaWh: num(r.consumptionDelta),
      costDeltaP: num(r.costDeltaWithTax),
    }));
  }
}
