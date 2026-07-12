"use client";

import { useState } from "react";
import { BaseloadCard } from "@/components/insights/BaseloadCard";
import { PeaksCard } from "@/components/insights/PeaksCard";
import { UsageHeatmap } from "@/components/insights/UsageHeatmap";
import { WeekCompareCard } from "@/components/insights/WeekCompareCard";
import { Card, ErrorNote, Segmented, Skeleton } from "@/components/ui";
import { useApi } from "@/components/useApi";
import type { Fuel, InsightsResponse, StatusResponse } from "@/lib/types";

/**
 * Insights: usage-pattern analytics for one fuel at a time — half-hourly
 * heatmap, always-on baseload, this-vs-last-week comparison and peak
 * half-hours. Follows /usage's conventions: fuel toggle, skeletons while
 * the first payload loads, an error note that keeps polling (useApi never
 * stops), and the setup-mode short-circuit.
 */
export default function InsightsPage() {
  const [fuel, setFuel] = useState<Fuel>("electricity");

  const status = useApi<StatusResponse>("/api/status");
  const hasGas =
    status.data?.meters.some((m) => m.fuel === "gas" && !m.isExport) ?? false;

  const insights = useApi<InsightsResponse>(`/api/insights?fuel=${fuel}`);

  if (status.data?.mode === "setup") {
    return (
      <Card>
        <p className="text-sm text-muted">
          No data yet — finish setup on the Overview page first.
        </p>
      </Card>
    );
  }

  const data = insights.data;

  return (
    <div className="space-y-4">
      <Segmented<Fuel>
        label="Fuel"
        value={fuel}
        onChange={setFuel}
        options={[
          { value: "electricity", label: "Electricity" },
          { value: "gas", label: "Gas", disabled: !hasGas },
        ]}
      />

      {insights.error && !data ? (
        <Card>
          <ErrorNote>Insights unavailable ({insights.error}). Retrying.</ErrorNote>
        </Card>
      ) : !data ? (
        <>
          <Card title="When you use energy">
            <Skeleton className="h-72 w-full" />
          </Card>
          <div className="grid gap-4 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <Card title="This week vs last week">
                <Skeleton className="h-64 w-full" />
              </Card>
            </div>
            <div className="space-y-4">
              <Card title="Always-on baseload">
                <Skeleton className="h-16 w-full" />
              </Card>
              <Card title="Highest half-hours · last 30 days">
                <Skeleton className="h-40 w-full" />
              </Card>
            </div>
          </div>
        </>
      ) : (
        <div
          className={`space-y-4 transition-opacity ${
            insights.loading ? "opacity-60" : ""
          }`}
        >
          <Card title="When you use energy">
            <UsageHeatmap heatmap={data.heatmap} fuel={fuel} />
          </Card>
          <div className="grid gap-4 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <WeekCompareCard weekCompare={data.weekCompare} fuel={fuel} />
            </div>
            <div className="space-y-4">
              <BaseloadCard baseload={data.baseload} />
              <PeaksCard peaks={data.peaks} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
