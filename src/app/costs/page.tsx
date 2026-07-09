"use client";

import { useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  AXIS_STROKE,
  BAR_CURSOR,
  DetailsTable,
  GRID_STROKE,
  SERIES_COLOR,
  SeriesTooltip,
  TICK_PROPS,
} from "@/components/charts";
import { dayLabel, pounds, poundsTick, shortDayLabel } from "@/components/format";
import {
  Card,
  Chip,
  ErrorNote,
  LegendItem,
  LegendRow,
  Skeleton,
  StatTile,
} from "@/components/ui";
import { useApi, useLocalToday } from "@/components/useApi";
import { addLocalDays, localDateRange } from "@/lib/time";
import type { CostsResponse, StatusResponse } from "@/lib/types";

/**
 * Costs: stacked daily bars for the last 30 days — energy + standing charge
 * above the axis, export earnings as a negative series below it
 * (stackOffset="sign") — plus 30-day totals and a 14-day table with
 * completeness chips. The stack's energy/standing pair is an ordinal ramp of
 * the electricity blue; export keeps its app-wide yellow.
 */

interface DayRow {
  date: string;
  energyP: number;
  standingP: number;
  /** Negative pence so the bar hangs below the axis. */
  exportNegP: number;
  elecP: number;
  gasP: number;
  exportP: number;
  elecSeen: boolean;
  gasSeen: boolean;
  exportSeen: boolean;
  partial: boolean;
}

export default function CostsPage() {
  const today = useLocalToday();
  const from = addLocalDays(today, -30);
  const to = addLocalDays(today, -1);

  const status = useApi<StatusResponse>("/api/status");
  const costs = useApi<CostsResponse>(`/api/costs?from=${from}&to=${to}`);

  const rows = useMemo<DayRow[]>(() => {
    // No cost rows at all (fresh install, day-late data) must hit the empty
    // state below, not render a zero-filled grid as if it were real data.
    if (!costs.data || costs.data.days.length === 0) return [];
    const byDate = new Map<string, DayRow>();
    for (const date of localDateRange(costs.data.from, costs.data.to)) {
      byDate.set(date, {
        date,
        energyP: 0,
        standingP: 0,
        exportNegP: 0,
        elecP: 0,
        gasP: 0,
        exportP: 0,
        elecSeen: false,
        gasSeen: false,
        exportSeen: false,
        partial: false,
      });
    }
    for (const d of costs.data.days) {
      const row = byDate.get(d.date);
      if (!row) continue;
      if (d.isExport) {
        row.exportNegP -= d.totalP;
        row.exportP += d.totalP;
        row.exportSeen = true;
      } else {
        row.energyP += d.energyP;
        row.standingP += d.standingP;
        if (d.fuel === "electricity") {
          row.elecP += d.totalP;
          row.elecSeen = true;
        } else {
          row.gasP += d.totalP;
          row.gasSeen = true;
        }
      }
      if (!d.complete) row.partial = true;
    }
    return [...byDate.values()];
  }, [costs.data]);

  if (status.data?.mode === "setup") {
    return (
      <Card>
        <p className="text-sm text-muted">
          No data yet — finish setup on the Overview page first.
        </p>
      </Card>
    );
  }

  const hasExport = rows.some((r) => r.exportSeen);
  const hasGas = rows.some((r) => r.gasSeen);
  const totals = costs.data?.totals;

  const legendItems: LegendItem[] = [
    { label: "Energy", color: SERIES_COLOR.electricity },
    { label: "Standing charge", color: SERIES_COLOR.standing },
    ...(hasExport
      ? [{ label: "Export earnings", color: SERIES_COLOR.export }]
      : []),
  ];

  const tableRows = rows.slice(-14).reverse();

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <StatTile
          label="Import cost (30 days)"
          value={totals ? (rows.length > 0 ? pounds(totals.importP) : "—") : null}
          sub={rows.length > 0 ? "energy + standing charges" : "no data yet"}
          loading={costs.loading && !costs.data}
        />
        <StatTile
          label="Export earnings"
          value={totals ? (rows.length > 0 ? pounds(totals.exportP) : "—") : null}
          loading={costs.loading && !costs.data}
        />
        <StatTile
          label="Net cost"
          value={totals ? (rows.length > 0 ? pounds(totals.netP) : "—") : null}
          sub={rows.length > 0 ? "import minus export" : undefined}
          loading={costs.loading && !costs.data}
        />
      </div>

      <Card title={`Daily cost · ${dayLabel(from)} – ${dayLabel(to)}`}>
        {costs.error && !costs.data ? (
          <ErrorNote>Costs unavailable ({costs.error}). Retrying.</ErrorNote>
        ) : !costs.data ? (
          <Skeleton className="h-80 w-full" />
        ) : rows.length === 0 ? (
          <p className="py-10 text-center text-sm text-faint">
            No cost data in this range.
          </p>
        ) : (
          <>
            <LegendRow items={legendItems} />
            <div
              className={`h-80 transition-opacity ${
                costs.loading ? "opacity-60" : ""
              }`}
            >
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={rows}
                  stackOffset="sign"
                  margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
                >
                  <CartesianGrid stroke={GRID_STROKE} vertical={false} />
                  <XAxis
                    dataKey="date"
                    tickFormatter={(v) => shortDayLabel(String(v))}
                    tick={TICK_PROPS}
                    tickLine={false}
                    axisLine={false}
                    minTickGap={24}
                  />
                  <YAxis
                    tick={TICK_PROPS}
                    tickLine={false}
                    axisLine={false}
                    width={44}
                    tickFormatter={(v) => poundsTick(Number(v))}
                  />
                  <ReferenceLine y={0} stroke={AXIS_STROKE} />
                  <Tooltip
                    cursor={BAR_CURSOR}
                    content={(p) => (
                      <SeriesTooltip
                        {...p}
                        formatLabel={(l) => dayLabel(l)}
                        formatValue={(v, key) =>
                          key === "exportNegP"
                            ? `${pounds(-v)} earned`
                            : pounds(v)
                        }
                      />
                    )}
                  />
                  <Bar
                    dataKey="energyP"
                    name="Energy"
                    stackId="day"
                    fill={SERIES_COLOR.electricity}
                    stroke="var(--surface-card)"
                    strokeWidth={1}
                    maxBarSize={24}
                    isAnimationActive={false}
                  />
                  <Bar
                    dataKey="standingP"
                    name="Standing charge"
                    stackId="day"
                    fill={SERIES_COLOR.standing}
                    stroke="var(--surface-card)"
                    strokeWidth={1}
                    radius={[4, 4, 0, 0]}
                    maxBarSize={24}
                    isAnimationActive={false}
                  />
                  {hasExport ? (
                    <Bar
                      dataKey="exportNegP"
                      name="Export earnings"
                      stackId="day"
                      fill={SERIES_COLOR.export}
                      stroke="var(--surface-card)"
                      strokeWidth={1}
                      radius={[0, 0, 4, 4]}
                      maxBarSize={24}
                      isAnimationActive={false}
                    />
                  ) : null}
                </BarChart>
              </ResponsiveContainer>
            </div>
            <DetailsTable
              head={[
                "Day",
                "Energy",
                "Standing",
                ...(hasExport ? ["Export"] : []),
              ]}
              rows={rows.map((r) => [
                dayLabel(r.date),
                pounds(r.energyP),
                pounds(r.standingP),
                ...(hasExport ? [pounds(r.exportP)] : []),
              ])}
            />
          </>
        )}
      </Card>

      <Card title="Last 14 days">
        {!costs.data ? (
          <Skeleton className="h-48 w-full" />
        ) : tableRows.length === 0 ? (
          <p className="text-sm text-faint">No data yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-hairline text-xs text-faint">
                  <th className="px-2 py-2 text-left font-medium">Day</th>
                  <th className="px-2 py-2 text-right font-medium">
                    Electricity
                  </th>
                  {hasGas ? (
                    <th className="px-2 py-2 text-right font-medium">Gas</th>
                  ) : null}
                  {hasExport ? (
                    <th className="px-2 py-2 text-right font-medium">
                      Export
                    </th>
                  ) : null}
                  <th className="px-2 py-2 text-right font-medium">Net</th>
                </tr>
              </thead>
              <tbody>
                {tableRows.map((r) => (
                  <tr
                    key={r.date}
                    className="border-b border-hairline last:border-b-0"
                  >
                    <td className="px-2 py-1.5">
                      <span className="inline-flex items-center gap-2">
                        {dayLabel(r.date)}
                        {r.partial ? <Chip>partial</Chip> : null}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">
                      {r.elecSeen ? pounds(r.elecP) : "—"}
                    </td>
                    {hasGas ? (
                      <td className="px-2 py-1.5 text-right tabular-nums">
                        {r.gasSeen ? pounds(r.gasP) : "—"}
                      </td>
                    ) : null}
                    {hasExport ? (
                      <td className="px-2 py-1.5 text-right tabular-nums">
                        {r.exportSeen ? pounds(r.exportP) : "—"}
                      </td>
                    ) : null}
                    <td className="px-2 py-1.5 text-right font-medium tabular-nums">
                      {pounds(r.elecP + r.gasP - r.exportP)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
