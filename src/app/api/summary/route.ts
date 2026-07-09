import { getSummary } from "@/lib/aggregate";
import { nowUtcIso } from "@/lib/time";
import type { SummaryResponse } from "@/lib/types";
import { isSetupModeError, respond } from "@/app/api/_lib/params";

/** GET /api/summary — yesterday tiles + month-to-date totals. */

export const dynamic = "force-dynamic";

export function GET(): Response {
  return respond<SummaryResponse>(() => {
    try {
      return getSummary();
    } catch (err) {
      if (!isSetupModeError(err)) throw err;
      return {
        yesterday: {},
        monthToDate: { importP: 0, exportP: 0, netP: 0, importKwh: 0 },
        completeThroughLocalDate: null,
        generatedAt: nowUtcIso(),
      };
    }
  });
}
