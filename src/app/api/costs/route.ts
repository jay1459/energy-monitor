import type { NextRequest } from "next/server";
import { getCosts } from "@/lib/aggregate";
import type { CostsResponse } from "@/lib/types";
import { isSetupModeError, parseDateRange, respond } from "@/app/api/_lib/params";

/**
 * GET /api/costs?from=yyyy-MM-dd&to=yyyy-MM-dd
 * Defaults to a 29-day window ending today.
 */

export const dynamic = "force-dynamic";

export function GET(request: NextRequest): Response {
  return respond<CostsResponse>(() => {
    const { from, to } = parseDateRange(request.nextUrl.searchParams, 29);
    try {
      return getCosts(from, to);
    } catch (err) {
      if (!isSetupModeError(err)) throw err;
      return { from, to, days: [], totals: { importP: 0, exportP: 0, netP: 0 } };
    }
  });
}
