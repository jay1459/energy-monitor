import { getStatus } from "@/lib/aggregate";
import { getConfig } from "@/lib/config";
import { nowUtcIso } from "@/lib/time";
import type { StatusResponse } from "@/lib/types";
import { isSetupModeError, respond } from "@/app/api/_lib/params";

/** GET /api/status — meter freshness + app mode. */

export const dynamic = "force-dynamic";

export function GET(): Response {
  return respond<StatusResponse>(() => {
    try {
      return getStatus();
    } catch (err) {
      if (!isSetupModeError(err)) throw err;
      return {
        mode: getConfig().mode,
        meters: [],
        telemetryAvailable: false,
        generatedAt: nowUtcIso(),
      };
    }
  });
}
