import { NextResponse, type NextRequest } from "next/server";
import { getUsage } from "@/lib/aggregate";
import type { UsageResponse } from "@/lib/types";
import {
  BadRequestError,
  isSetupModeError,
  parseDateRange,
  parseExportFlag,
  parseFuel,
  parseResolution,
} from "@/app/api/_lib/params";

/**
 * GET /api/export?fuel=electricity|gas&export=1&from=yyyy-MM-dd&to=yyyy-MM-dd
 *     &resolution=halfhour|day|week|month
 * CSV download of the same data as /api/usage (same params and defaults:
 * electricity import, 7-day window ending today, daily buckets). Columns:
 * period_start,kwh,cost_pence_inc_vat — a null cost renders as an empty
 * cell, never 0. Served as an attachment named
 * energy-<fuel>[-export]-<from>-<to>-<resolution>.csv.
 */

export const dynamic = "force-dynamic";

export function GET(request: NextRequest): Response {
  try {
    const params = request.nextUrl.searchParams;
    const fuel = parseFuel(params);
    const isExport = parseExportFlag(params);
    const resolution = parseResolution(params);
    const { from, to } = parseDateRange(params, 7);

    let usage: UsageResponse;
    try {
      usage = getUsage(fuel, isExport, from, to, resolution);
    } catch (err) {
      if (!isSetupModeError(err)) throw err;
      usage = { fuel, isExport, resolution, from, to, points: [] }; // header-only CSV
    }

    const lines = ["period_start,kwh,cost_pence_inc_vat"];
    for (const point of usage.points) {
      lines.push(`${point.t},${point.kwh},${point.costP ?? ""}`);
    }
    const filename = `energy-${fuel}${isExport ? "-export" : ""}-${from}-${to}-${resolution}.csv`;
    return new Response(lines.join("\n") + "\n", {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    // respond() only produces JSON responses; replicate its error mapping here.
    if (err instanceof BadRequestError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error("[api]", err);
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
