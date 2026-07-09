import { getLive } from "@/lib/aggregate";
import type { LiveResponse } from "@/lib/types";
import { isSetupModeError, respond } from "@/app/api/_lib/params";

/** GET /api/live — latest Home Mini telemetry snapshot. */

export const dynamic = "force-dynamic";

export function GET(): Response {
  return respond<LiveResponse>(() => {
    try {
      return getLive();
    } catch (err) {
      if (!isSetupModeError(err)) throw err;
      return { available: false };
    }
  });
}
