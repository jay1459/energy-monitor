import type { NextRequest } from "next/server";
import { getComparison, newestCompleteImportDay } from "@/lib/compare";
import { addLocalDays, localDaySpan, nowUtcIso, todayLocal } from "@/lib/time";
import type { CompareResponse } from "@/lib/types";
import { isSetupModeError, parseDateRange, respond } from "@/app/api/_lib/params";

/**
 * GET /api/compare?from=yyyy-MM-dd&to=yyyy-MM-dd
 * Defaults: `to` = newest local day complete across import meters (falling
 * back to yesterday before any complete data exists), `from` = `to` - 29 —
 * a 30-day inclusive window of settled consumption.
 */

export const dynamic = "force-dynamic";

export function GET(request: NextRequest): Response {
  return respond<CompareResponse>(() => {
    // parseDateRange defaults `to` to today; compare wants a complete day,
    // so inject the default before the shared validation runs.
    const params = new URLSearchParams(request.nextUrl.searchParams);
    if (!params.has("to")) {
      params.set("to", newestCompleteImportDay() ?? addLocalDays(todayLocal(), -1));
    }
    const { from, to } = parseDateRange(params, 30);
    try {
      return getComparison(from, to);
    } catch (err) {
      if (!isSetupModeError(err)) throw err;
      return {
        from,
        to,
        dayCount: localDaySpan(from, to),
        quotes: [],
        candidatesSyncedAt: null,
        generatedAt: nowUtcIso(),
      };
    }
  });
}
