"use client";

import { pounds, watts } from "@/components/format";
import { Card } from "@/components/ui";
import type { InsightsResponse } from "@/lib/types";

/**
 * Always-on baseload: median overnight (01:00–05:00 local) draw as a
 * headline wattage, priced over a full year at the current unit rate. The
 * API returns null watts until enough complete days exist; that renders as
 * an explicit "not enough data" message, never a fake zero. annualCostP can
 * be null independently (rates not synced) — the headline still shows.
 */
export function BaseloadCard({
  baseload,
}: {
  baseload: InsightsResponse["baseload"];
}) {
  return (
    <Card title="Always-on baseload">
      {baseload.watts === null ? (
        <p className="text-sm text-faint">
          Not enough data yet — this needs a run of complete overnight readings
          {baseload.sampleDays > 0 ? ` (${baseload.sampleDays} day${
            baseload.sampleDays === 1 ? "" : "s"
          } so far)` : ""}
          .
        </p>
      ) : (
        <>
          <p className="text-3xl font-semibold tracking-tight">
            {watts(baseload.watts)}
          </p>
          {baseload.annualCostP !== null ? (
            <p className="mt-0.5 text-sm text-muted">
              ≈ {pounds(baseload.annualCostP)}/year at your current rate
            </p>
          ) : null}
          <p className="mt-2 text-xs text-faint">
            Median overnight draw, 01:00–05:00, last {baseload.sampleDays}{" "}
            complete days.
          </p>
        </>
      )}
    </Card>
  );
}
