import type { NextRequest } from "next/server";
import { emptyInsights, getInsights } from "@/lib/insights";
import type { InsightsResponse } from "@/lib/types";
import { isSetupModeError, parseFuel, respond } from "@/app/api/_lib/params";

/**
 * GET /api/insights?fuel=electricity|gas
 * Defaults: electricity. Usage-pattern analytics (heatmap, baseload,
 * week-over-week compare, peak half-hours) for the import meter.
 */

export const dynamic = "force-dynamic";

export function GET(request: NextRequest): Response {
  return respond<InsightsResponse>(() => {
    const fuel = parseFuel(request.nextUrl.searchParams);
    try {
      return getInsights(fuel);
    } catch (err) {
      if (!isSetupModeError(err)) throw err;
      return emptyInsights(fuel);
    }
  });
}
