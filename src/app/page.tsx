"use client";

import { useMemo } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  ACTIVE_DOT,
  AXIS_STROKE,
  DetailsTable,
  GRID_STROKE,
  LINE_CURSOR,
  SERIES_COLOR,
  SeriesTooltip,
  TICK_PROPS,
} from "@/components/charts";
import {
  clockLabel,
  dayLabel,
  fuelLabel,
  kwh,
  penceRate,
  pounds,
  watts,
} from "@/components/format";
import { SetupCard } from "@/components/SetupCard";
import {
  Card,
  ErrorNote,
  LegendItem,
  LegendRow,
  ModeBadge,
  Skeleton,
  StatTile,
} from "@/components/ui";
import { useApi, useLocalToday } from "@/components/useApi";
import { addLocalDays } from "@/lib/time";
import type {
  LiveResponse,
  RatesResponse,
  StatusResponse,
  SummaryResponse,
  UsageResponse,
} from "@/lib/types";

/**
 * Overview: stat tiles (live demand, yesterday's usage, month-to-date net),
 * yesterday's half-hourly chart, and a freshness/rates footer. In setup
 * mode the whole page is replaced by setup instructions.
 */

interface HalfHourRow {
  t: string;
  electricity?: number;
  gas?: number;
  export?: number;
}

const SERIES_KEYS = ["electricity", "gas", "export"] as const;
type SeriesKey = (typeof SERIES_KEYS)[number];

const SERIES_NAME: Record<SeriesKey, string> = {
  electricity: "Electricity",
  gas: "Gas",
  export: "Solar export",
};

export default function OverviewPage() {
  const today = useLocalToday();
  const yesterday = addLocalDays(today, -1);

  const status = useApi<StatusResponse>("/api/status");
  const ready = status.data !== null && status.data.mode !== "setup";

  const hasGas =
    status.data?.meters.some((m) => m.fuel === "gas" && !m.isExport) ?? false;
  const hasExport = status.data?.meters.some((m) => m.isExport) ?? false;

  const summary = useApi<SummaryResponse>(ready ? "/api/summary" : null);
  const live = useApi<LiveResponse>(ready ? "/api/live" : null, 30_000);
  const rates = useApi<RatesResponse>(ready ? "/api/rates" : null);

  const usageUrl = (fuel: "electricity" | "gas", isExport: boolean) =>
    `/api/usage?fuel=${fuel}${isExport ? "&export=1" : ""}` +
    `&from=${yesterday}&to=${yesterday}&resolution=halfhour`;

  const elecUsage = useApi<UsageResponse>(
    ready ? usageUrl("electricity", false) : null
  );
  const gasUsage = useApi<UsageResponse>(
    ready && hasGas ? usageUrl("gas", false) : null
  );
  const exportUsage = useApi<UsageResponse>(
    ready && hasExport ? usageUrl("electricity", true) : null
  );

  const chartRows = useMemo<HalfHourRow[]>(() => {
    const map = new Map<string, HalfHourRow>();
    const merge = (resp: UsageResponse | null, key: SeriesKey) => {
      for (const p of resp?.points ?? []) {
        const row = map.get(p.t) ?? { t: p.t };
        row[key] = p.kwh;
        map.set(p.t, row);
      }
    };
    merge(elecUsage.data, "electricity");
    merge(gasUsage.data, "gas");
    merge(exportUsage.data, "export");
    // UTC ISO keys sort lexicographically.
    return [...map.values()].sort((a, b) => (a.t < b.t ? -1 : 1));
  }, [elecUsage.data, gasUsage.data, exportUsage.data]);

  if (status.error && !status.data) {
    return (
      <Card>
        <ErrorNote>
          Can&apos;t reach the API ({status.error}). Retrying automatically.
        </ErrorNote>
      </Card>
    );
  }
  if (!status.data) {
    return <OverviewSkeleton />;
  }
  if (status.data.mode === "setup") {
    return <SetupCard />;
  }

  const activeSeries: SeriesKey[] = SERIES_KEYS.filter((key) =>
    key === "electricity" ? true : key === "gas" ? hasGas : hasExport
  );
  const legendItems: LegendItem[] = activeSeries.map((key) => ({
    label: SERIES_NAME[key],
    color: SERIES_COLOR[key],
    shape: "line",
  }));
  const usageLoading =
    elecUsage.loading || gasUsage.loading || exportUsage.loading;
  // A series whose fetch failed outright is missing from the chart — say so
  // instead of letting it pass for "no data published yet".
  const failedSeries = (
    [
      [elecUsage, "electricity"],
      [gasUsage, "gas"],
      [exportUsage, "export"],
    ] as const
  )
    .filter(([hook]) => hook.error && !hook.data)
    .map(([, key]) => SERIES_NAME[key]);

  const yd = summary.data?.yesterday;
  const mtd = summary.data?.monthToDate;
  const tilesLoading = summary.loading && !summary.data;

  return (
    <div className="space-y-4">
      {summary.error && !summary.data ? (
        <ErrorNote>Summary unavailable ({summary.error}). Retrying.</ErrorNote>
      ) : null}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
        {live.data && live.data.available ? (
          <StatTile
            label="Live demand"
            value={live.data.demandW != null ? watts(live.data.demandW) : "—"}
            sub={
              live.data.todayKwh != null
                ? `today ${kwh(live.data.todayKwh)}${
                    live.data.todayCostP != null
                      ? ` · ${pounds(live.data.todayCostP)}`
                      : ""
                  }`
                : live.data.readAt
                  ? `at ${clockLabel(live.data.readAt)}`
                  : undefined
            }
          />
        ) : (
          <StatTile
            label="Live demand"
            value={null}
            sub="Live view needs an Octopus Home Mini"
            loading={live.loading && !live.data}
          />
        )}
        <StatTile
          label="Yesterday electricity"
          value={yd?.electricity ? kwh(yd.electricity.kwh) : null}
          sub={yd?.electricity ? pounds(yd.electricity.costP) : "no data yet"}
          partial={yd?.electricity ? !yd.electricity.complete : false}
          loading={tilesLoading}
        />
        {hasGas ? (
          <StatTile
            label="Yesterday gas"
            value={yd?.gas ? kwh(yd.gas.kwh) : null}
            sub={yd?.gas ? pounds(yd.gas.costP) : "no data yet"}
            partial={yd?.gas ? !yd.gas.complete : false}
            loading={tilesLoading}
          />
        ) : null}
        {hasExport ? (
          <StatTile
            label="Solar export yesterday"
            value={yd?.export ? kwh(yd.export.kwh) : null}
            sub={yd?.export ? `${pounds(yd.export.costP)} earned` : "no data yet"}
            partial={yd?.export ? !yd.export.complete : false}
            loading={tilesLoading}
          />
        ) : null}
        <StatTile
          label="Net cost this month"
          value={mtd ? pounds(mtd.netP) : null}
          sub={
            mtd
              ? `import ${pounds(mtd.importP)}${
                  hasExport ? ` · export ${pounds(mtd.exportP)}` : ""
                }`
              : undefined
          }
          loading={tilesLoading}
        />
      </div>

      <Card title={`Yesterday by half hour · ${dayLabel(yesterday)} · kWh`}>
        {legendItems.length >= 2 ? <LegendRow items={legendItems} /> : null}
        {failedSeries.length > 0 && chartRows.length > 0 ? (
          <ErrorNote>
            {failedSeries.join(", ")} failed to load — chart is missing those
            series. Retrying.
          </ErrorNote>
        ) : null}
        {failedSeries.length > 0 && chartRows.length === 0 ? (
          <ErrorNote>
            Usage unavailable ({failedSeries.join(", ")} failed). Retrying.
          </ErrorNote>
        ) : chartRows.length === 0 ? (
          usageLoading ? (
            <Skeleton className="h-72 w-full" />
          ) : (
            <p className="py-10 text-center text-sm text-faint">
              No half-hourly data for yesterday yet — Octopus usually publishes
              it by mid-morning.
            </p>
          )
        ) : (
          <>
            <div
              className={`h-72 transition-opacity ${
                usageLoading ? "opacity-60" : ""
              }`}
            >
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart
                  data={chartRows}
                  margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
                >
                  <CartesianGrid stroke={GRID_STROKE} vertical={false} />
                  <XAxis
                    dataKey="t"
                    tickFormatter={(v) => clockLabel(String(v))}
                    tick={TICK_PROPS}
                    tickLine={false}
                    axisLine={{ stroke: AXIS_STROKE }}
                    minTickGap={32}
                  />
                  <YAxis
                    tick={TICK_PROPS}
                    tickLine={false}
                    axisLine={false}
                    width={40}
                  />
                  <Tooltip
                    cursor={LINE_CURSOR}
                    content={(p) => (
                      <SeriesTooltip
                        {...p}
                        formatLabel={(l) => clockLabel(l)}
                        formatValue={(v) => kwh(v)}
                      />
                    )}
                  />
                  {activeSeries.map((key) => (
                    <Area
                      key={key}
                      type="monotone"
                      dataKey={key}
                      name={SERIES_NAME[key]}
                      stroke={SERIES_COLOR[key]}
                      strokeWidth={2}
                      fill={SERIES_COLOR[key]}
                      fillOpacity={0.1}
                      dot={false}
                      activeDot={ACTIVE_DOT}
                      isAnimationActive={false}
                    />
                  ))}
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <DetailsTable
              head={[
                "Starts",
                ...activeSeries.map((k) => `${SERIES_NAME[k]} kWh`),
              ]}
              rows={chartRows.map((row) => [
                clockLabel(row.t),
                ...activeSeries.map((k) =>
                  row[k] != null ? row[k].toFixed(3) : "—"
                ),
              ])}
            />
          </>
        )}
      </Card>

      <Card>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted">
          <ModeBadge mode={status.data.mode} />
          {status.data.meters.map((m) => (
            <span key={m.meterPointId}>
              {m.label || fuelLabel(m.fuel, m.isExport)}{" "}
              {m.completeThroughLocalDate
                ? `complete through ${dayLabel(m.completeThroughLocalDate)}`
                : "no data yet"}
            </span>
          ))}
          {rates.data?.rates
            .filter((r) => r.unitRatePIncVat != null)
            .map((r) => (
              <span key={`${r.fuel}-${r.isExport}`}>
                {fuelLabel(r.fuel, r.isExport)}{" "}
                {penceRate(r.unitRatePIncVat!, "kWh")}
                {!r.isExport && r.standingPIncVat != null
                  ? ` + ${penceRate(r.standingPIncVat, "day")}`
                  : ""}
              </span>
            ))}
          {status.refreshedAt ? (
            <span className="ml-auto text-faint">
              Updated {clockLabel(status.refreshedAt)}
            </span>
          ) : null}
        </div>
      </Card>
    </div>
  );
}

function OverviewSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <StatTile key={i} label="Loading" value={null} loading />
        ))}
      </div>
      <Card>
        <Skeleton className="h-72 w-full" />
      </Card>
    </div>
  );
}
