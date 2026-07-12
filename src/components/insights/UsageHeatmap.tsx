"use client";

import { Fragment } from "react";
import { DateTime } from "luxon";
import { SERIES_COLOR } from "@/components/charts";
import { kwh } from "@/components/format";
import { LONDON } from "@/lib/time";
import type { Fuel, InsightsResponse } from "@/lib/types";

/**
 * "When you use energy" heatmap: columns are Europe/London days (oldest
 * left), rows the 48 half-hour clock slots (00:00 top). Cell fill is a
 * sequential ramp mixed in OKLab from the neutral grid token to the fuel's
 * series color — both theme-aware CSS variables, so the ramp re-anchors in
 * dark mode instead of flipping automatically. The ramp is linear in kWh so
 * the min/max legend stays honest; zero wears the neutral base and null (no
 * reading) is fully transparent, keeping "no data" visibly distinct from
 * "used nothing". Values are reachable per cell via native title tooltips.
 * DST days arrive pre-folded onto the 48-slot clock by the API.
 */

const CELL = 11; // px cell size
const GAP = 2; // px surface gap between fills (dataviz spacer rule)
const SLOT_LABEL_EVERY = 8; // one hour label per 4 hours

/** Slot index (0..47) -> local clock label "HH:mm". */
function slotLabel(slot: number): string {
  const h = Math.floor(slot / 2);
  return `${String(h).padStart(2, "0")}:${slot % 2 === 0 ? "00" : "30"}`;
}

export function UsageHeatmap({
  heatmap,
  fuel,
}: {
  heatmap: InsightsResponse["heatmap"];
  fuel: Fuel;
}) {
  const color = SERIES_COLOR[fuel];
  const { days, maxKwh } = heatmap;

  if (days.length === 0) {
    return <p className="py-10 text-center text-sm text-faint">No data yet.</p>;
  }

  const cellBackground = (value: number): string => {
    const pct = maxKwh > 0 ? Math.min(1, Math.max(0, value / maxKwh)) * 100 : 0;
    return `color-mix(in oklab, ${color} ${pct.toFixed(1)}%, var(--chart-grid))`;
  };

  // Weekly x labels on Mondays; short histories without one label day 1.
  const mondays = days
    .map((d, i) => ({ i, dt: DateTime.fromISO(d.date, { zone: LONDON }) }))
    .filter(({ dt }) => dt.weekday === 1);
  const xLabels =
    mondays.length > 0
      ? mondays
      : [{ i: 0, dt: DateTime.fromISO(days[0].date, { zone: LONDON }) }];

  const columnTemplate = `repeat(${days.length}, ${CELL}px)`;
  const rowTemplate = `repeat(48, ${CELL}px)`;

  return (
    <div>
      <div className="flex">
        {/* Hour labels sit outside the scroll area so they never scroll away. */}
        <div
          className="shrink-0 pr-2"
          style={{ display: "grid", gridTemplateRows: rowTemplate, gap: GAP }}
          aria-hidden
        >
          {Array.from({ length: 48 / SLOT_LABEL_EVERY }, (_, k) => (
            <span
              key={k}
              className="text-[10px] leading-none text-faint"
              style={{ gridRowStart: k * SLOT_LABEL_EVERY + 1 }}
            >
              {slotLabel(k * SLOT_LABEL_EVERY)}
            </span>
          ))}
        </div>

        <div className="overflow-x-auto pb-1">
          <div
            role="img"
            aria-label={`Half-hourly ${fuel} usage heatmap, ${heatmap.from} to ${heatmap.to}`}
            style={{
              display: "grid",
              gridAutoFlow: "column",
              gridTemplateRows: rowTemplate,
              gridTemplateColumns: columnTemplate,
              gap: GAP,
            }}
          >
            {days.map((day) => {
              const dayPart = DateTime.fromISO(day.date, { zone: LONDON }).toFormat(
                "EEE d LLL"
              );
              return (
                <Fragment key={day.date}>
                  {day.kwh.map((value, slot) =>
                    value === null ? (
                      <div
                        key={slot}
                        title={`${dayPart} ${slotLabel(slot)} — no data`}
                      />
                    ) : (
                      <div
                        key={slot}
                        className="rounded-[2px]"
                        title={`${dayPart} ${slotLabel(slot)} — ${kwh(value)}`}
                        style={{ background: cellBackground(value) }}
                      />
                    )
                  )}
                </Fragment>
              );
            })}
          </div>

          {/* Weekly date labels, aligned to the same column tracks. */}
          <div
            className="mt-1"
            style={{ display: "grid", gridTemplateColumns: columnTemplate, gap: GAP }}
            aria-hidden
          >
            {xLabels.map(({ i, dt }) => (
              <span
                key={i}
                className="whitespace-nowrap text-[10px] leading-none text-faint"
                style={{ gridColumnStart: i + 1 }}
              >
                {dt.toFormat("d LLL")}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Compact color-scale legend: min and max of the linear ramp. */}
      <div className="mt-3 flex items-center gap-1.5 text-[10px] text-faint">
        <span>0</span>
        <span
          className="h-2 w-24 rounded-full"
          style={{
            background: `linear-gradient(to right, var(--chart-grid), ${color})`,
          }}
          aria-hidden
        />
        <span>{kwh(maxKwh)}</span>
        <span className="ml-1">per half-hour</span>
      </div>
    </div>
  );
}
