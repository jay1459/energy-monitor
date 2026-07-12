"use client";

import { useState } from "react";
import { DateTime } from "luxon";
import { pounds } from "@/components/format";
import { Card, Chip, ErrorNote, Skeleton } from "@/components/ui";
import { DateRangeControls } from "@/components/DateRangeControls";
import { useApi, useLocalToday } from "@/components/useApi";
import { addLocalDays } from "@/lib/time";
import type { CompareResponse, StatusResponse, TariffQuote } from "@/lib/types";

/**
 * Compare: replays the household's actual half-hourly usage under candidate
 * Octopus tariffs over a picked date range (ending yesterday — REST data is
 * day-late). Quotes arrive cheapest-first per fuel with the current tariff
 * included; deltas are vs the current tariff's total for the same range.
 * Coverage below 100% marks a row partial (candidate rates may not span the
 * whole range yet); the headline verdict needs at least 90% coverage.
 */

/** A rolling last-N-days preset, or a pinned custom range. */
type RangeState = { preset: number } | { from: string; to: string };

/** Verdict and per-row deltas are hidden when rates cover less than this. */
const VERDICT_MIN_COVERAGE_PCT = 90;

/** Signed delta in pounds: "−£4.12" saves, "+£4.12" costs more, "£0.00" even. */
function signedPounds(deltaP: number): string {
  const abs = (Math.abs(deltaP) / 100).toFixed(2);
  if (abs === "0.00") return "£0.00";
  return `${deltaP < 0 ? "−" : "+"}£${abs}`;
}

/** UTC instant -> "2 hours ago" (falls back to the raw instant). */
function relativeLabel(utcIso: string): string {
  return DateTime.fromISO(utcIso, { setZone: true }).toRelative() ?? utcIso;
}

export default function ComparePage() {
  const today = useLocalToday();
  const [range, setRange] = useState<RangeState>({ preset: 30 });
  const maxTo = addLocalDays(today, -1);
  const from = "preset" in range ? addLocalDays(maxTo, -(range.preset - 1)) : range.from;
  const to = "preset" in range ? maxTo : range.to;

  const status = useApi<StatusResponse>("/api/status");
  const compare = useApi<CompareResponse>(`/api/compare?from=${from}&to=${to}`);

  if (status.data?.mode === "setup") {
    return (
      <Card>
        <p className="text-sm text-muted">
          No data yet — finish setup on the Overview page first.
        </p>
      </Card>
    );
  }

  const quotes = compare.data?.quotes ?? [];
  const elec = quotes.filter((q) => q.fuel === "electricity");
  const gas = quotes.filter((q) => q.fuel === "gas");
  const hasCandidates = quotes.some((q) => !q.isCurrent);
  const anyPartial = quotes.some((q) => q.coveragePct < 100);

  // Headline: cheapest ELIGIBLE non-current electricity quote vs current.
  // Eligibility filters coverage per candidate — a partial-coverage quote
  // only looks artificially cheap, and picking strictly the first row would
  // let it suppress the verdict for a fully-priced candidate sorted after it.
  const currentElec = elec.find((q) => q.isCurrent);
  const cheapestAlt = elec.find(
    (q) => !q.isCurrent && q.coveragePct >= VERDICT_MIN_COVERAGE_PCT
  );
  const verdict =
    compare.data &&
    currentElec &&
    cheapestAlt &&
    currentElec.coveragePct >= VERDICT_MIN_COVERAGE_PCT
      ? { name: cheapestAlt.displayName, deltaP: cheapestAlt.totalP - currentElec.totalP }
      : null;

  return (
    <div className="space-y-4">
      <DateRangeControls
        from={from}
        to={to}
        maxTo={maxTo}
        activePreset={"preset" in range ? range.preset : null}
        onPreset={(days) => setRange({ preset: days })}
        onCustom={(f, t) => setRange({ from: f, to: t })}
        label="Comparison range"
      />

      {compare.error && !compare.data ? (
        <Card>
          <ErrorNote>Comparison unavailable ({compare.error}). Retrying.</ErrorNote>
        </Card>
      ) : !compare.data ? (
        <Card>
          <Skeleton className="h-64 w-full" />
        </Card>
      ) : quotes.length === 0 ? (
        <Card>
          <p className="py-10 text-center text-sm text-faint">
            No comparison data in this range.
          </p>
        </Card>
      ) : (
        <>
          {verdict ? (
            <Card>
              <p className="text-xs font-medium text-muted">
                Cheapest alternative · electricity
              </p>
              <p className="mt-1 text-xl font-semibold tracking-tight">
                {verdict.name} would have cost {pounds(Math.abs(verdict.deltaP))}{" "}
                {verdict.deltaP < 0 ? "less" : "more"} over these{" "}
                {compare.data.dayCount} days
              </p>
            </Card>
          ) : null}

          {!hasCandidates ? (
            <Card>
              <p className="py-6 text-center text-sm text-faint">
                Nothing to compare against yet — candidate tariff rates have not
                been synced. Quotes for other tariffs will appear here once the
                comparison job has run.
              </p>
            </Card>
          ) : null}

          {elec.length > 0 ? <QuoteTable fuelName="Electricity" rows={elec} /> : null}
          {gas.length > 0 ? <QuoteTable fuelName="Gas" rows={gas} /> : null}

          <div className="space-y-1 text-xs text-faint">
            {anyPartial ? (
              <p>
                Rows marked partial data are tariffs whose synced rates do not
                cover the whole range yet — their totals only price the covered
                intervals, so treat them as a lower bound.
              </p>
            ) : null}
            <p>
              Assumes the same usage pattern under every tariff — time-of-use
              tariffs like Agile reward shifting usage, which a like-for-like
              replay cannot capture. Excludes one-off credits; standing charges
              are included. Export tariffs are out of scope.
            </p>
            {compare.data.candidatesSyncedAt ? (
              <p>
                Candidate rates updated{" "}
                {relativeLabel(compare.data.candidatesSyncedAt)}.
              </p>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

/** Amber variant of the grey Chip — flags partial rate coverage on a row. */
function WarnChip({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="inline-flex items-center rounded-full border px-1.5 py-px text-[10px] font-medium uppercase tracking-wide"
      style={{ color: "var(--status-warn)", borderColor: "var(--status-warn)" }}
    >
      {children}
    </span>
  );
}

function QuoteTable({ fuelName, rows }: { fuelName: string; rows: TariffQuote[] }) {
  const current = rows.find((r) => r.isCurrent) ?? null;
  return (
    <Card title={fuelName}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-hairline text-xs text-faint">
              <th className="px-2 py-2 text-left font-medium">Tariff</th>
              <th className="px-2 py-2 text-right font-medium">Energy</th>
              <th className="px-2 py-2 text-right font-medium">Standing</th>
              <th className="px-2 py-2 text-right font-medium">Total</th>
              <th className="px-2 py-2 text-right font-medium">vs current</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((q) => (
              <tr
                key={q.tariffCode}
                className="border-b border-hairline last:border-b-0"
              >
                <td className="px-2 py-1.5">
                  <span className="inline-flex flex-wrap items-center gap-2">
                    {q.displayName}
                    {q.isCurrent ? <Chip>current</Chip> : null}
                    {q.coveragePct < 100 ? (
                      <WarnChip>partial data ({Math.round(q.coveragePct)}%)</WarnChip>
                    ) : null}
                  </span>
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums">
                  {pounds(q.energyP)}
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums">
                  {pounds(q.standingP)}
                </td>
                <td className="px-2 py-1.5 text-right font-medium tabular-nums">
                  {pounds(q.totalP)}
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums">
                  {q.isCurrent || !current ? (
                    <span className="text-muted">—</span>
                  ) : (
                    signedPounds(q.totalP - current.totalP)
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
