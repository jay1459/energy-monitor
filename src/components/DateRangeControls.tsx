"use client";

import { Segmented } from "@/components/ui";
import { addLocalDays, localDaySpan } from "@/lib/time";

/**
 * Shared date-range picker: arrows step the window by its own span, presets
 * jump to the last N days ending at maxTo, and the two native date inputs
 * take any custom range. Presets stay "sticky" (they roll forward at
 * midnight via the caller's state); arrows and manual dates pin a custom
 * range that does not roll.
 */

/** The API rejects ranges over 400 days. */
const MAX_SPAN_DAYS = 400;

const ARROW_BTN =
  "rounded-md px-2.5 py-1 text-xs font-medium text-muted transition-colors " +
  "hover:bg-foreground/5 disabled:cursor-not-allowed disabled:opacity-40";

const DATE_INPUT =
  "rounded-lg border border-hairline bg-card px-2 py-1 text-xs text-foreground " +
  "[color-scheme:light_dark]";

export function DateRangeControls({
  from,
  to,
  maxTo,
  presets = [7, 30, 90],
  activePreset,
  onPreset,
  onCustom,
  label,
}: {
  from: string;
  to: string;
  /** Newest selectable date — data is day-late, so usually yesterday. */
  maxTo: string;
  presets?: number[];
  /** Which preset produced the current range; null when it's custom. */
  activePreset: number | null;
  onPreset: (days: number) => void;
  onCustom: (from: string, to: string) => void;
  label: string;
}) {
  const span = localDaySpan(from, to);
  const atEnd = to >= maxTo;

  const clamp = (f: string, t: string): [string, string] => {
    if (t > maxTo) t = maxTo;
    if (f > t) f = t;
    if (localDaySpan(f, t) > MAX_SPAN_DAYS) f = addLocalDays(t, -(MAX_SPAN_DAYS - 1));
    return [f, t];
  };

  const shift = (dir: -1 | 1) => {
    let t = addLocalDays(to, dir * span);
    let f = addLocalDays(from, dir * span);
    if (t > maxTo) {
      t = maxTo;
      f = addLocalDays(t, -(span - 1));
    }
    onCustom(...clamp(f, t));
  };

  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label={label}>
      <div className="inline-flex rounded-lg border border-hairline bg-card p-0.5">
        <button
          type="button"
          aria-label={`Back ${span} day${span === 1 ? "" : "s"}`}
          title={`Back ${span} day${span === 1 ? "" : "s"}`}
          onClick={() => shift(-1)}
          className={ARROW_BTN}
        >
          ←
        </button>
        <button
          type="button"
          aria-label={`Forward ${span} day${span === 1 ? "" : "s"}`}
          title={atEnd ? "Already at the newest data" : `Forward ${span} day${span === 1 ? "" : "s"}`}
          disabled={atEnd}
          onClick={() => shift(1)}
          className={ARROW_BTN}
        >
          →
        </button>
      </div>

      <Segmented<string>
        label={`${label} presets`}
        value={activePreset !== null ? String(activePreset) : "custom"}
        onChange={(v) => onPreset(Number(v))}
        options={presets.map((days) => ({ value: String(days), label: `${days} days` }))}
      />

      <div className="inline-flex items-center gap-1.5">
        <input
          type="date"
          value={from}
          max={to}
          aria-label="Start date"
          onChange={(e) => {
            const v = e.target.value;
            if (!v) return;
            onCustom(...clamp(v, to < v ? v : to));
          }}
          className={DATE_INPUT}
        />
        <span className="text-xs text-faint">–</span>
        <input
          type="date"
          value={to}
          max={maxTo}
          aria-label="End date"
          onChange={(e) => {
            const v = e.target.value;
            if (!v) return;
            onCustom(...clamp(from > v ? v : from, v));
          }}
          className={DATE_INPUT}
        />
      </div>
    </div>
  );
}
