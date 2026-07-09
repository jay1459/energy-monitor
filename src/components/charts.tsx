"use client";

/**
 * Shared chart plumbing for Recharts. Colors are CSS variables (defined in
 * globals.css) so marks re-theme with prefers-color-scheme; series colors
 * follow the entity — electricity is always blue, gas aqua, export yellow —
 * never the series' position in a particular chart.
 *
 * Two light-mode series (gas, export) sit below 3:1 contrast on the surface,
 * so every chart pairs with a DetailsTable twin and a full tooltip (the
 * relief channel required by the palette validation).
 */

export const SERIES_COLOR = {
  electricity: "var(--chart-elec)",
  gas: "var(--chart-gas)",
  export: "var(--chart-export)",
  standing: "var(--chart-standing)",
} as const;

export const TICK_PROPS = { fill: "var(--chart-tick)", fontSize: 11 } as const;
export const GRID_STROKE = "var(--chart-grid)";
export const AXIS_STROKE = "var(--chart-axis)";
/** Hover wash behind bars. */
export const BAR_CURSOR = { fill: "var(--chart-cursor)" } as const;
/** Crosshair for line/area charts. */
export const LINE_CURSOR = { stroke: "var(--chart-axis)" } as const;
/** 2px surface ring so active dots stay legible where lines cross. */
export const ACTIVE_DOT = {
  r: 4,
  strokeWidth: 2,
  stroke: "var(--surface-card)",
} as const;

interface TooltipEntry {
  dataKey?: string | number;
  name?: string | number;
  value?: unknown;
  color?: string;
  fill?: string;
}

/**
 * Tooltip content listing every series at the hovered X. Values lead
 * (strong), series names follow (muted), keyed by a short stroke of the
 * series color. Pass via `content={(p) => <SeriesTooltip {...p} … />}`.
 */
export function SeriesTooltip({
  active,
  payload,
  label,
  formatLabel,
  formatValue,
}: {
  active?: boolean;
  payload?: unknown;
  label?: unknown;
  formatLabel?: (label: string) => string;
  formatValue: (value: number, dataKey: string) => string;
}) {
  if (!active) return null;
  const entries = (Array.isArray(payload) ? (payload as TooltipEntry[]) : [])
    .filter((e) => typeof e.value === "number");
  if (entries.length === 0) return null;
  return (
    <div className="rounded-lg border border-hairline bg-card px-3 py-2 shadow-sm">
      <p className="mb-1 text-xs text-faint">
        {formatLabel ? formatLabel(String(label)) : String(label)}
      </p>
      <ul className="space-y-0.5">
        {entries.map((e) => (
          <li
            key={String(e.dataKey)}
            className="flex items-center gap-2 text-xs"
          >
            <span
              className="h-0.5 w-3 shrink-0 rounded-full"
              style={{ background: e.color ?? e.fill ?? "var(--faint)" }}
              aria-hidden
            />
            <span className="font-semibold">
              {formatValue(e.value as number, String(e.dataKey))}
            </span>
            <span className="text-muted">{String(e.name ?? e.dataKey)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The chart's table-view twin — every plotted value reachable without hover
 * or color perception. Collapsed by default to keep the page quiet.
 */
export function DetailsTable({
  summary = "View as table",
  head,
  rows,
}: {
  summary?: string;
  head: string[];
  rows: string[][];
}) {
  return (
    <details className="mt-3">
      <summary className="cursor-pointer text-xs text-faint hover:text-muted">
        {summary}
      </summary>
      <div className="mt-2 max-h-64 overflow-auto rounded-lg border border-hairline">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-hairline">
              {head.map((h, i) => (
                <th
                  key={h}
                  className={`px-3 py-1.5 font-medium text-faint ${
                    i === 0 ? "text-left" : "text-right"
                  }`}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r} className="border-b border-hairline last:border-b-0">
                {row.map((cell, i) => (
                  <td
                    key={i}
                    className={`px-3 py-1 ${
                      i === 0 ? "text-left" : "text-right tabular-nums"
                    }`}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
