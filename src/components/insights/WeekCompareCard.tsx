"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
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
import { kwh } from "@/components/format";
import { Card, LegendRow } from "@/components/ui";
import type { Fuel, InsightsResponse } from "@/lib/types";

/**
 * This week vs last week, grouped bars per weekday (Mon..Sun). "This week"
 * wears the fuel's series color; "last week" is the same hue knocked back
 * toward the surface with color-mix — a two-step ordinal ramp, theme-aware
 * in both modes. Mix percentages are per fuel so the near-surface step still
 * clears the 2:1 ordinal floor (dataviz validator --ordinal: all four
 * fuel×mode pairs PASS; gas full-color light-mode contrast stays sub-3:1 as
 * documented in globals.css, relieved by the DetailsTable twin + tooltip).
 * Days with no complete data map null -> undefined so Recharts skips the bar
 * instead of drawing a zero. The delta headline carries its meaning in
 * words — status green when usage is down is reinforcement, never the only
 * channel.
 */

/** % of the series color in the "last week" mix (rest is surface). */
const LAST_WEEK_MIX: Record<Fuel, number> = { electricity: 55, gas: 72 };

export function WeekCompareCard({
  weekCompare,
  fuel,
}: {
  weekCompare: InsightsResponse["weekCompare"];
  fuel: Fuel;
}) {
  const color = SERIES_COLOR[fuel];
  const lastWeekColor = `color-mix(in oklab, ${color} ${LAST_WEEK_MIX[fuel]}%, var(--surface-card))`;

  const data = weekCompare.days.map((d) => ({
    weekday: d.weekday,
    thisWeek: d.thisWeekKwh ?? undefined,
    lastWeek: d.lastWeekKwh ?? undefined,
  }));
  const hasAny = weekCompare.days.some(
    (d) => d.thisWeekKwh !== null || d.lastWeekKwh !== null
  );

  // deltaPct is like-for-like (only weekdays complete in BOTH weeks feed
  // it), so a partial in-progress week never claims a fake "drop" — the
  // wording reflects that.
  const delta = weekCompare.deltaPct;
  let deltaText = "no comparable days last week yet";
  let deltaLower = false;
  if (delta !== null) {
    const pct = Math.abs(Math.round(delta));
    if (pct === 0) {
      deltaText = "about the same as these days last week";
    } else if (delta < 0) {
      deltaText = `${pct}% less than the same days last week`;
      deltaLower = true;
    } else {
      deltaText = `${pct}% more than the same days last week`;
    }
  }

  return (
    <Card title="This week vs last week">
      {!hasAny ? (
        <p className="py-10 text-center text-sm text-faint">
          No complete days in either week yet.
        </p>
      ) : (
        <>
          <div className="mb-3">
            <p className="text-2xl font-semibold tracking-tight">
              {kwh(weekCompare.thisWeekTotalKwh)}
              <span className="ml-1.5 text-sm font-normal text-muted">
                this week
              </span>
            </p>
            <p
              className={`mt-0.5 text-xs ${deltaLower ? "" : "text-muted"}`}
              style={deltaLower ? { color: "var(--status-ok)" } : undefined}
            >
              {deltaText}
              {delta !== null
                ? ` (last week ${kwh(weekCompare.lastWeekTotalKwh)})`
                : ""}
            </p>
          </div>

          <LegendRow
            items={[
              { label: "This week", color },
              { label: "Last week", color: lastWeekColor },
            ]}
          />

          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid stroke={GRID_STROKE} vertical={false} />
                <XAxis
                  dataKey="weekday"
                  tick={TICK_PROPS}
                  tickLine={false}
                  axisLine={{ stroke: AXIS_STROKE }}
                />
                <YAxis tick={TICK_PROPS} tickLine={false} axisLine={false} width={40} />
                <Tooltip
                  cursor={BAR_CURSOR}
                  content={(p) => (
                    <SeriesTooltip {...p} formatValue={(v) => kwh(v)} />
                  )}
                />
                <Bar
                  dataKey="thisWeek"
                  name="This week"
                  fill={color}
                  radius={[4, 4, 0, 0]}
                  maxBarSize={16}
                  isAnimationActive={false}
                />
                <Bar
                  dataKey="lastWeek"
                  name="Last week"
                  fill={lastWeekColor}
                  radius={[4, 4, 0, 0]}
                  maxBarSize={16}
                  isAnimationActive={false}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <DetailsTable
            head={["Day", "This week", "Last week"]}
            rows={weekCompare.days.map((d) => [
              d.weekday,
              d.thisWeekKwh !== null ? d.thisWeekKwh.toFixed(2) : "—",
              d.lastWeekKwh !== null ? d.lastWeekKwh.toFixed(2) : "—",
            ])}
          />
        </>
      )}
    </Card>
  );
}
