import { deleteState, getDb, getState, setState } from "@/lib/db";
import { getDataSource } from "@/lib/octopus/source";
import { nowUtc, nowUtcIso, parseInstant, utcIso } from "@/lib/time";

/**
 * Home Mini telemetry sync (dormant until a device exists — live mode
 * with no Home Mini simply logs once and returns).
 *
 * - Device ids come from source.getTelemetryDeviceIds(), cached in
 *   sync_state "telemetry_devices" as {ids, discoveredAt} and re-discovered
 *   after 24h so the GraphQL discovery query doesn't run every 10 minutes.
 * - Each run fetches a SMALL window: [max(latest stored read_at,
 *   now - 20 min), now] at ONE_MINUTE grouping (10-min cadence doesn't
 *   need 10s rows; upstream retention is a rolling window, so never
 *   backfill far).
 * - Upsert on (device_id, read_at). Gaps from downtime are accepted —
 *   the half-hourly REST data is the durable record; telemetry powers
 *   only the live view.
 */

const DEVICE_CACHE_KEY = "telemetry_devices";
const DORMANT_LOGGED_KEY = "telemetry_dormant_logged";
const DEVICE_CACHE_TTL_HOURS = 24;
const WINDOW_MINUTES = 20;
const RETENTION_DAYS = 7;

interface DeviceCache {
  ids: string[];
  discoveredAt: string;
}

function readDeviceCache(): DeviceCache | null {
  const raw = getState(DEVICE_CACHE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<DeviceCache>;
    if (Array.isArray(parsed.ids) && typeof parsed.discoveredAt === "string") {
      return {
        ids: parsed.ids.filter((id): id is string => typeof id === "string"),
        discoveredAt: parsed.discoveredAt,
      };
    }
  } catch {
    // Corrupt cache — fall through to re-discovery.
  }
  return null;
}

export async function syncTelemetry(): Promise<void> {
  const db = getDb();
  const source = await getDataSource();

  let cache = readDeviceCache();
  const staleBefore = nowUtc().minus({ hours: DEVICE_CACHE_TTL_HOURS });
  if (!cache || parseInstant(cache.discoveredAt) < staleBefore) {
    try {
      const ids = await source.getTelemetryDeviceIds();
      cache = { ids, discoveredAt: nowUtcIso() };
      setState(DEVICE_CACHE_KEY, JSON.stringify(cache));
    } catch (err) {
      // Transient discovery failure must not go dark for 24h or wipe a
      // known-good device list — keep the stale cache and retry next tick.
      if (cache) {
        console.warn("[telemetry] device re-discovery failed, using cached ids:", err);
      } else {
        throw new Error(`smart device discovery failed: ${String(err)}`);
      }
    }
  }

  if (cache.ids.length === 0) {
    // Log the dormant state once, not every 10 minutes.
    if (!getState(DORMANT_LOGGED_KEY)) {
      console.log("[telemetry] no Home Mini — telemetry dormant");
      setState(DORMANT_LOGGED_KEY, nowUtcIso());
    }
    return;
  }
  deleteState(DORMANT_LOGGED_KEY);

  const latestStmt = db.prepare(
    "SELECT MAX(read_at) AS latest FROM telemetry WHERE device_id = ?"
  );
  const upsert = db.prepare(
    `INSERT INTO telemetry
       (device_id, read_at, demand_w, consumption_wh, export_wh, consumption_delta_wh, cost_delta_p)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(device_id, read_at) DO UPDATE SET
       demand_w = excluded.demand_w,
       consumption_wh = excluded.consumption_wh,
       export_wh = excluded.export_wh,
       consumption_delta_wh = excluded.consumption_delta_wh,
       cost_delta_p = excluded.cost_delta_p`
  );

  const errors: string[] = [];
  for (const deviceId of cache.ids) {
    try {
      const { latest } = latestStmt.get(deviceId) as { latest: string | null };
      const floor = utcIso(nowUtc().minus({ minutes: WINDOW_MINUTES }));
      const fromUtc = latest && latest > floor ? latest : floor;
      const toUtc = nowUtcIso();
      if (fromUtc >= toUtc) continue;

      const readings = await source.getTelemetry(deviceId, fromUtc, toUtc, "ONE_MINUTE");
      if (readings.length === 0) continue;

      db.transaction(() => {
        for (const r of readings) {
          upsert.run(
            deviceId,
            r.readAt,
            r.demandW,
            r.consumptionWh,
            r.exportWh,
            r.consumptionDeltaWh,
            r.costDeltaP
          );
        }
      })();
    } catch (err) {
      console.error(`[telemetry] device ${deviceId}: sync failed —`, err);
      errors.push(`${deviceId}: ${String(err)}`);
    }
  }

  // Telemetry only powers the live view (REST half-hours are the durable
  // record) — prune so the table can't grow without bound.
  db.prepare("DELETE FROM telemetry WHERE read_at < ?").run(
    utcIso(nowUtc().minus({ days: RETENTION_DAYS }))
  );

  if (errors.length > 0) {
    throw new Error(
      `telemetry sync failed for ${errors.length}/${cache.ids.length} device(s): ` +
        errors.join(" | ")
    );
  }
}
