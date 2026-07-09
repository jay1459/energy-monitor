import type { NextRequest } from "next/server";
import { getUsage } from "@/lib/aggregate";
import type { UsageResponse } from "@/lib/types";
import {
  isSetupModeError,
  parseDateRange,
  parseExportFlag,
  parseFuel,
  parseResolution,
  respond,
} from "@/app/api/_lib/params";

/**
 * GET /api/usage?fuel=electricity|gas&export=1&from=yyyy-MM-dd&to=yyyy-MM-dd
 *     &resolution=halfhour|day|week|month
 * Defaults: electricity import, 7-day window ending today, daily buckets.
 */

export const dynamic = "force-dynamic";

export function GET(request: NextRequest): Response {
  return respond<UsageResponse>(() => {
    const params = request.nextUrl.searchParams;
    const fuel = parseFuel(params);
    const isExport = parseExportFlag(params);
    const resolution = parseResolution(params);
    const { from, to } = parseDateRange(params, 7);
    try {
      return getUsage(fuel, isExport, from, to, resolution);
    } catch (err) {
      if (!isSetupModeError(err)) throw err;
      return { fuel, isExport, resolution, from, to, points: [] };
    }
  });
}
