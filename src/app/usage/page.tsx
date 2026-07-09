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
import {
  dayLabel,
  instantLabel,
  kwh,
  monthLabel,
  pounds,
  shortDayLabel,
} from "@/components/format";
import { Card, ErrorNote, Segmented, Skeleton, StatTile } from "@/components/ui";
import { useApi, useLocalToday } from "@/components/useApi";
import { DateTime } from "luxon";
import { LONDON, addLocalDays } from "@/lib/time";
import type { Resolution, StatusResponse, UsageResponse } from "@/lib/types";

/**
 * Usage explorer: one series at a time (fuel tab), preset ranges ending
 * yesterday (REST data is day-late), resolution toggle. Half-hour resolution
 * is only offered for ranges of 14 days or fewer.
 */

type FuelTab = "electricity" | "gas" | "export";
type RangeDays = 7 | 30 | 90;

const TAB_NAME: Record<FuelTab, string> = {
  electricity: "Electricity",
  gas: "Gas",
  export: "Solar export",
};

const HALFHOUR_MAX_DAYS = 14;

function tickLabel(t: string, resolution: Resolution): string {
  switch (resolution) {
    case "halfhour":
      return DateTime.fromISO(t, { setZone: true })
        .setZone(LONDON)
        .toFormat("EEE HH:mm");
    case "month":
      return monthLabel(t);
    default:
      return shortDayLabel(t);
  }
}

function bucketLabel(t: string, resolution: Resolution): string {
  switch (resolution) {
    case "halfhour":
      return instantLabel(t);
    case "week":
      return `Week of ${dayLabel(t)}`;
    case "month":
      return monthLabel(t);
    default:
      return dayLabel(t);
  }
}

export default function UsagePage() {
  const [tab, setTab] = useState<FuelTab>("electricity");
  const [rangeDays, setRangeDays] = useState<RangeDays>(30);
  const [resolution, setResolution] = useState<Resolution>("day");

  const today = useLocalToday();
  const from = addLocalDays(today, -rangeDays);
  const to = addLocalDays(today, -1);

  const status = useApi<StatusResponse>("/api/status");
  const hasGas =
    status.data?.meters.some((m) => m.fuel === "gas" && !m.isExport) ?? false;
  const hasExport = status.data?.meters.some((m) => m.isExport) ?? false;

  const fuel = tab === "gas" ? "gas" : "electricity";
  const isExport = tab === "export";
  const usage = useApi<UsageResponse>(
    `/api/usage?fuel=${fuel}${isExport ? "&export=1" : ""}` +
      `&from=${from}&to=${to}&resolution=${resolution}`
  );

  const points = usage.data?.points ?? [];
  const totalKwh = points.reduce((sum, p) => sum + p.kwh, 0);
  const costed = points.filter((p) => p.costP !== null);
  const totalCostP = costed.reduce((sum, p) => sum + (p.costP ?? 0), 0);
  const missingRates = costed.length < points.length;

  const pickRange = (days: RangeDays) => {
    setRangeDays(days);
    if (days > HALFHOUR_MAX_DAYS && resolution === "halfhour") {
      setResolution("day");
    }
  };

  const color = SERIES_COLOR[tab];
  const seriesName = TAB_NAME[tab];

  if (status.data?.mode === "setup") {
    return (
      <Card>
        <p className="text-sm text-muted">
          No data yet — finish setup on the Overview page first.
        </p>
      </Card>
    );
  }

  const renderTooltip = (p: {
    active?: boolean;
    payload?: unknown;
    label?: unknown;
  }) => {
    const entries = Array.isArray(p.payload)
      ? (p.payload as Array<{ payload?: { t: string; kwh: number; costP: number | null } }>)
      : [];
    const datum = entries[0]?.payload;
    if (!p.active || !datum) return null;
    return (
      <div className="rounded-lg border border-hairline bg-card px-3 py-2 shadow-sm">
        <p className="mb-1 text-xs text-faint">
          {bucketLabel(datum.t, resolution)}
        </p>
        <p className="text-xs font-semibold">{kwh(datum.kwh)}</p>
        {datum.costP !== null ? (
          <p className="text-xs text-muted">
            {pounds(datum.costP)}
            {isExport ? " earned" : ""}
          </p>
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
      tickFormatter={(v) => tickLabel(String(v), resolution)}
      tick={TICK_PROPS}
      tickLine={false}
      axisLine={{ stroke: AXIS_STROKE }}
      minTickGap={28}
    />
  );
  const yAxis = (
    <YAxis tick={TICK_PROPS} tickLine={false} axisLine={false} width={40} />
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented<FuelTab>
          label="Fuel"
          value={tab}
          onChange={setTab}
          options={[
            { value: "electricity", label: "Electricity" },
            { value: "gas", label: "Gas", disabled: !hasGas },
            { value: "export", label: "Solar export", disabled: !hasExport },
          ]}
        />
        <Segmented<`${RangeDays}`>
          label="Range"
          value={`${rangeDays}`}
          onChange={(v) => pickRange(Number(v) as RangeDays)}
          options={[
            { value: "7", label: "7 days" },
            { value: "30", label: "30 days" },
            { value: "90", label: "90 days" },
          ]}
        />
        <Segmented<Resolution>
          label="Resolution"
          value={resolution}
          onChange={setResolution}
          options={[
            {
              value: "halfhour",
              label: "Half-hour",
              disabled: rangeDays > HALFHOUR_MAX_DAYS,
            },
            { value: "day", label: "Day" },
            { value: "week", label: "Week" },
            { value: "month", label: "Month" },
          ]}
        />
        <span className="text-xs text-faint">
          {dayLabel(from)} – {dayLabel(to)}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:max-w-md">
        <StatTile
          label={`${seriesName} total`}
          value={usage.data ? kwh(totalKwh) : null}
          loading={usage.loading && !usage.data}
        />
        <StatTile
          label={isExport ? "Earned" : "Energy cost"}
          value={
            usage.data ? (costed.length > 0 ? pounds(totalCostP) : "—") : null
          }
          sub={
            isExport
              ? undefined
              : missingRates
                ? "excl. standing charge; some rates unknown"
                : "excludes standing charge"
          }
          loading={usage.loading && !usage.data}
        />
      </div>

      <Card title={`${seriesName} · ${bucketTitle(resolution)} · kWh`}>
        {usage.error && !usage.data ? (
          <ErrorNote>Usage unavailable ({usage.error}). Retrying.</ErrorNote>
        ) : !usage.data ? (
          <Skeleton className="h-80 w-full" />
        ) : points.length === 0 ? (
          <p className="py-10 text-center text-sm text-faint">
            No data in this range.
          </p>
        ) : (
          <>
            <div
              className={`h-80 transition-opacity ${
                usage.loading ? "opacity-60" : ""
              }`}
            >
              <ResponsiveContainer width="100%" height="100%">
                {resolution === "halfhour" ? (
                  <AreaChart {...chartProps}>
                    <CartesianGrid stroke={GRID_STROKE} vertical={false} />
                    {xAxis}
                    {yAxis}
                    <Tooltip cursor={LINE_CURSOR} content={renderTooltip} />
                    <Area
                      type="monotone"
                      dataKey="kwh"
                      name={seriesName}
                      stroke={color}
                      strokeWidth={2}
                      fill={color}
                      fillOpacity={0.1}
                      dot={false}
                      activeDot={ACTIVE_DOT}
                      isAnimationActive={false}
                    />
                  </AreaChart>
                ) : (
                  <BarChart {...chartProps}>
                    <CartesianGrid stroke={GRID_STROKE} vertical={false} />
                    {xAxis}
                    {yAxis}
                    <Tooltip cursor={BAR_CURSOR} content={renderTooltip} />
                    <Bar
                      dataKey="kwh"
                      name={seriesName}
                      fill={color}
                      radius={[4, 4, 0, 0]}
                      maxBarSize={24}
                      isAnimationActive={false}
                    />
                  </BarChart>
                )}
              </ResponsiveContainer>
            </div>
            <DetailsTable
              head={["Period", "kWh", isExport ? "Earned" : "Cost"]}
              rows={points.map((p) => [
                bucketLabel(p.t, resolution),
                p.kwh.toFixed(resolution === "halfhour" ? 3 : 2),
                p.costP !== null ? pounds(p.costP) : "—",
              ])}
            />
          </>
        )}
      </Card>
    </div>
  );
}

function bucketTitle(resolution: Resolution): string {
  switch (resolution) {
    case "halfhour":
      return "by half hour";
    case "day":
      return "by day";
    case "week":
      return "by week";
    case "month":
      return "by month";
  }
}
