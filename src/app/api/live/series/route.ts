import type { NextRequest } from "next/server";
import { getLiveSeries } from "@/lib/aggregate";
import type { LiveSeriesResponse } from "@/lib/types";
import {
  isSetupModeError,
  parseLiveGranularity,
  parseOptionalLocalDate,
  respond,
} from "@/app/api/_lib/params";

/**
 * GET /api/live/series?granularity=1|5|15|30&date=yyyy-MM-dd
 * One Europe/London day of Home Mini telemetry, bucketed to the requested
 * minute granularity, plus the latest live snapshot. Defaults: 1-minute
 * buckets, today. Reads SQLite only — never the Octopus API.
 */

export const dynamic = "force-dynamic";

export function GET(request: NextRequest): Response {
  return respond<LiveSeriesResponse>(() => {
    const params = request.nextUrl.searchParams;
    const granularity = parseLiveGranularity(params);
    const date = parseOptionalLocalDate(params, "date");
    try {
      return getLiveSeries(granularity, date);
    } catch (err) {
      if (!isSetupModeError(err)) throw err;
      return { available: false };
    }
  });
}
