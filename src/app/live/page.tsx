"use client";

import { useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  ACTIVE_DOT,
  AXIS_STROKE,
  BAR_CURSOR,
  DetailsTable,
  GRID_STROKE,
  LINE_CURSOR,
  SERIES_COLOR,
  TICK_PROPS,
} from "@/components/charts";
import { clockLabel, kwh, pounds, watts } from "@/components/format";
import { Card, Chip, ErrorNote, Segmented, Skeleton, StatTile } from "@/components/ui";
import { useApi, useLocalToday } from "@/components/useApi";
import { dayLabel } from "@/components/format";
import type { LiveSeriesResponse, StatusResponse } from "@/lib/types";

/**
 * Live view: today's Home Mini telemetry, minute by minute (with 5/15/30-min
 * granularity options), refreshed every 15 s. Data is only as fresh as the
 * telemetry collector's last poll, so a "live"/"stale" chip reflects whether
 * the feed is currently flowing. Reads /api/live/series (SQLite, never the
 * Octopus API).
 */

const REFRESH_MS = 15_000;

type Metric = "demand" | "energy";
/** String keys so the value flows straight into the query param and Segmented. */
type Granularity = "1" | "5" | "15" | "30";

const GRANULARITIES: { value: Granularity; label: string }[] = [
  { value: "1", label: "1 min" },
  { value: "5", label: "5 min" },
  { value: "15", label: "15 min" },
  { value: "30", label: "30 min" },
];

/** Compact axis label for watts: "412", "1.2k". */
function wattTick(w: number): string {
  return Math.abs(w) >= 1000 ? `${(w / 1000).toFixed(1)}k` : String(Math.round(w));
}

export default function LivePage() {
  const [granularity, setGranularity] = useState<Granularity>("1");
  const [metric, setMetric] = useState<Metric>("demand");

  const today = useLocalToday();
  const status = useApi<StatusResponse>("/api/status");
  const live = useApi<LiveSeriesResponse>(
    status.data && status.data.mode !== "setup"
      ? `/api/live/series?granularity=${granularity}&date=${today}`
      : null,
    REFRESH_MS
  );

  if (status.data?.mode === "setup") {
    return (
      <Card>
        <p className="text-sm text-muted">
          No data yet — finish setup on the Overview page first.
        </p>
      </Card>
    );
  }

  const data = live.data;
  const points = data?.points ?? [];
  const color = SERIES_COLOR.electricity;

  // "Not available" here means no Home Mini feed at all — distinct from a live
  // feed that simply has no data yet for today.
  const noDevice = data !== null && !data.available;

  const renderTooltip = (p: { active?: boolean; payload?: unknown }) => {
    const entries = Array.isArray(p.payload)
      ? (p.payload as Array<{
          payload?: {
            t: string;
            demandW: number | null;
            kwh: number;
            costP: number | null;
          };
        }>)
      : [];
    const datum = entries[0]?.payload;
    if (!p.active || !datum) return null;
    return (
      <div className="rounded-lg border border-hairline bg-card px-3 py-2 shadow-sm">
        <p className="mb-1 text-xs text-faint">{clockLabel(datum.t)}</p>
        {datum.demandW !== null ? (
          <p className="text-xs font-semibold">{watts(datum.demandW)}</p>
        ) : null}
        <p className="text-xs text-muted">{kwh(datum.kwh)}</p>
        {datum.costP !== null ? (
          <p className="text-xs text-muted">{pounds(datum.costP)}</p>
        ) : null}
      </div>
    );
  };

  const chartProps = {
    data: points,
    margin: { top: 8, right: 8, bottom: 0, left: 0 },
  };
  const xAxis = (
    <XAxis
      dataKey="t"
      tickFormatter={(v) => clockLabel(String(v))}
      tick={TICK_PROPS}
      tickLine={false}
      axisLine={{ stroke: AXIS_STROKE }}
      minTickGap={40}
    />
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented<Granularity>
          label="Granularity"
          value={granularity}
          onChange={setGranularity}
          options={GRANULARITIES}
        />
        <Segmented<Metric>
          label="Metric"
          value={metric}
          onChange={setMetric}
          options={[
            { value: "demand", label: "Demand" },
            { value: "energy", label: "Energy" },
          ]}
        />
        {data?.available ? (
          <span className="ml-auto inline-flex items-center gap-1.5 text-xs text-muted">
            {data.live ? (
              <Chip>live</Chip>
            ) : (
              <Chip>stale</Chip>
            )}
            {data.latestReadAt
              ? `latest ${clockLabel(data.latestReadAt)}`
              : null}
          </span>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:max-w-2xl">
        <StatTile
          label="Live demand"
          value={
            data?.available && data.latestDemandW != null
              ? watts(data.latestDemandW)
              : data?.available
                ? "—"
                : null
          }
          sub={data?.latestReadAt ? `at ${clockLabel(data.latestReadAt)}` : undefined}
          loading={live.loading && !live.data}
        />
        <StatTile
          label="Today's energy"
          value={data?.available && data.totalKwh != null ? kwh(data.totalKwh) : null}
          loading={live.loading && !live.data}
        />
        <StatTile
          label="Today's cost"
          value={
            data?.available
              ? data.totalCostP != null
                ? pounds(data.totalCostP)
                : "—"
              : null
          }
          sub="energy only, excl. standing charge"
          loading={live.loading && !live.data}
        />
      </div>

      <Card
        title={`Today · ${dayLabel(today)} · ${
          metric === "demand" ? "demand (W)" : "energy (kWh)"
        } · ${granularity}-min buckets`}
      >
        {noDevice ? (
          <p className="py-10 text-center text-sm text-faint">
            No live feed — the live view needs an Octopus Home Mini reporting
            telemetry.
          </p>
        ) : live.error && !live.data ? (
          <ErrorNote>Live data unavailable ({live.error}). Retrying.</ErrorNote>
        ) : !live.data ? (
          <Skeleton className="h-80 w-full" />
        ) : points.length === 0 ? (
          <p className="py-10 text-center text-sm text-faint">
            Waiting for today&apos;s telemetry — readings appear as the Home
            Mini reports through the day.
          </p>
        ) : (
          <>
            <div
              className={`h-80 transition-opacity ${
                live.loading ? "opacity-60" : ""
              }`}
            >
              <ResponsiveContainer width="100%" height="100%">
                {metric === "demand" ? (
                  <AreaChart {...chartProps}>
                    <CartesianGrid stroke={GRID_STROKE} vertical={false} />
                    {xAxis}
                    <YAxis
                      tick={TICK_PROPS}
                      tickLine={false}
                      axisLine={false}
                      width={40}
                      tickFormatter={(v) => wattTick(Number(v))}
                    />
                    <Tooltip cursor={LINE_CURSOR} content={renderTooltip} />
                    <Area
                      type="monotone"
                      dataKey="demandW"
                      name="Demand"
                      stroke={color}
                      strokeWidth={2}
                      fill={color}
                      fillOpacity={0.1}
                      dot={false}
                      activeDot={ACTIVE_DOT}
                      connectNulls
                      isAnimationActive={false}
                    />
                  </AreaChart>
                ) : (
                  <BarChart {...chartProps}>
                    <CartesianGrid stroke={GRID_STROKE} vertical={false} />
                    {xAxis}
                    <YAxis
                      tick={TICK_PROPS}
                      tickLine={false}
                      axisLine={false}
                      width={40}
                    />
                    <Tooltip cursor={BAR_CURSOR} content={renderTooltip} />
                    <Bar
                      dataKey="kwh"
                      name="Energy"
                      fill={color}
                      radius={[3, 3, 0, 0]}
                      maxBarSize={24}
                      isAnimationActive={false}
                    />
                  </BarChart>
                )}
              </ResponsiveContainer>
            </div>
            <DetailsTable
              head={["Time", "Demand", "kWh", "Cost"]}
              rows={points.map((p) => [
                clockLabel(p.t),
                p.demandW !== null ? watts(p.demandW) : "—",
                p.kwh.toFixed(3),
                p.costP !== null ? pounds(p.costP) : "—",
              ])}
            />
          </>
        )}
      </Card>
    </div>
  );
}
