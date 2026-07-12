"use client";

import { instantLabel, pounds } from "@/components/format";
import { Card } from "@/components/ui";
import type { InsightsResponse } from "@/lib/types";

/**
 * Top five half-hours by consumption over the last 30 days, descending as
 * delivered by the API. Times render in Europe/London via the shared
 * formatter; cost is an em dash when no rate covered the interval.
 */
export function PeaksCard({ peaks }: { peaks: InsightsResponse["peaks"] }) {
  return (
    <Card title="Highest half-hours · last 30 days">
      {peaks.length === 0 ? (
        <p className="text-sm text-faint">No data yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-hairline text-xs text-faint">
                <th className="px-2 py-2 text-left font-medium">When</th>
                <th className="px-2 py-2 text-right font-medium">kWh</th>
                <th className="px-2 py-2 text-right font-medium">Cost</th>
              </tr>
            </thead>
            <tbody>
              {peaks.map((p) => (
                <tr
                  key={p.intervalStart}
                  className="border-b border-hairline last:border-b-0"
                >
                  <td className="px-2 py-1.5 whitespace-nowrap">
                    {instantLabel(p.intervalStart)}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {p.kwh.toFixed(2)}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {p.costP !== null ? pounds(p.costP) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
