"use client";

import { Card } from "@/components/ui";

/**
 * Replaces the Overview when the app boots without credentials
 * (mode === "setup"). Mirrors the instructions in .env.example.
 */

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-foreground/5 px-1.5 py-0.5 font-mono text-[13px]">
      {children}
    </code>
  );
}

export function SetupCard() {
  return (
    <Card className="mx-auto max-w-2xl">
      <h1 className="text-lg font-semibold tracking-tight">
        Connect your Octopus Energy account
      </h1>
      <p className="mt-2 text-sm text-muted">
        The dashboard has no credentials yet, so there is nothing to show.
        Three steps and it will start collecting your smart-meter data.
      </p>
      <ol className="mt-4 list-decimal space-y-3 pl-5 text-sm">
        <li>
          Copy <Code>.env.example</Code> to <Code>.env.local</Code> in the
          project root.
        </li>
        <li>
          Set <Code>OCTOPUS_API_KEY</Code> — find it at{" "}
          <span className="font-medium">octopus.energy</span> dashboard →
          Personal details → Developer settings.
        </li>
        <li>
          Set <Code>OCTOPUS_ACCOUNT_NUMBER</Code> — the reference that looks
          like <Code>A-12AB34CD</Code>, shown on the same page and on every
          bill.
        </li>
      </ol>
      <p className="mt-4 text-sm text-muted">
        Then restart the server. The collector backfills history on first run,
        so the first load can take a minute.
      </p>
      <p className="mt-3 border-t border-hairline pt-3 text-sm text-muted">
        Just exploring? Set <Code>ENERGY_MOCK=1</Code> in{" "}
        <Code>.env.local</Code> instead to run against synthetic demo data —
        no account or network needed.
      </p>
    </Card>
  );
}
