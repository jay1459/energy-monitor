"use client";

import type { AppMode } from "@/lib/types";

/**
 * Small presentational atoms shared across pages. No data fetching here.
 * Stat-tile values keep proportional figures (no tabular-nums) per the
 * dataviz spec; tabular-nums is reserved for table columns and axis ticks.
 */

export function Card({
  title,
  children,
  className = "",
}: {
  title?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-xl border border-hairline bg-card p-4 sm:p-5 ${className}`}
    >
      {title ? (
        <h2 className="mb-3 text-sm font-medium text-muted">{title}</h2>
      ) : null}
      {children}
    </section>
  );
}

export function StatTile({
  label,
  value,
  sub,
  partial = false,
  loading = false,
}: {
  label: string;
  value: string | null;
  sub?: string;
  partial?: boolean;
  loading?: boolean;
}) {
  return (
    <div className="rounded-xl border border-hairline bg-card p-4">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-muted">{label}</span>
        {partial ? <Chip>partial</Chip> : null}
      </div>
      {loading ? (
        <Skeleton className="mt-2 h-7 w-24" />
      ) : (
        <p className="mt-1 text-2xl font-semibold tracking-tight">
          {value ?? "—"}
        </p>
      )}
      {sub ? <p className="mt-0.5 text-xs text-faint">{sub}</p> : null}
    </div>
  );
}

/** Grey chip, e.g. "partial" on incomplete days. */
export function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-hairline px-1.5 py-px text-[10px] font-medium uppercase tracking-wide text-faint">
      {children}
    </span>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return (
    <div
      className={`animate-pulse rounded-md bg-foreground/10 ${className}`}
      aria-hidden
    />
  );
}

export function ErrorNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-sm text-muted" role="alert">
      {children}
    </p>
  );
}

const MODE_LABEL: Record<AppMode, string> = {
  live: "LIVE",
  mock: "DEMO",
  setup: "SETUP",
};

const MODE_DOT: Record<AppMode, string> = {
  live: "var(--status-ok)",
  mock: "var(--status-warn)",
  setup: "var(--faint)",
};

/** Mode badge — colored dot plus label, never color alone. */
export function ModeBadge({ mode }: { mode: AppMode | undefined }) {
  if (!mode) return <Skeleton className="h-5 w-14 rounded-full" />;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-hairline px-2 py-0.5 text-[11px] font-medium tracking-wide text-muted">
      <span
        className="size-1.5 rounded-full"
        style={{ background: MODE_DOT[mode] }}
        aria-hidden
      />
      {MODE_LABEL[mode]}
    </span>
  );
}

export interface LegendItem {
  label: string;
  color: string;
  shape?: "square" | "line";
}

/** HTML legend row — present whenever a chart has two or more series. */
export function LegendRow({ items }: { items: LegendItem[] }) {
  return (
    <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1">
      {items.map((item) => (
        <span
          key={item.label}
          className="inline-flex items-center gap-1.5 text-xs text-muted"
        >
          {item.shape === "line" ? (
            <span
              className="h-0.5 w-3.5 rounded-full"
              style={{ background: item.color }}
              aria-hidden
            />
          ) : (
            <span
              className="size-2.5 rounded-[3px]"
              style={{ background: item.color }}
              aria-hidden
            />
          )}
          {item.label}
        </span>
      ))}
    </div>
  );
}

/** Segmented control for tabs / range presets / resolution toggles. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: ReadonlyArray<{ value: T; label: string; disabled?: boolean }>;
  value: T;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="inline-flex rounded-lg border border-hairline bg-card p-0.5"
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            disabled={opt.disabled}
            aria-pressed={active}
            onClick={() => onChange(opt.value)}
            className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
              active
                ? "bg-foreground/10 text-foreground"
                : "text-muted hover:bg-foreground/5"
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
