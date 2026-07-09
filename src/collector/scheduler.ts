import cron from "node-cron";
import { getConfig } from "@/lib/config";
import { getState, setState } from "@/lib/db";
import { nowUtcIso } from "@/lib/time";
import { syncAccount } from "@/collector/bootstrap";
import { syncConsumption } from "@/collector/consumption";
import { syncRates } from "@/collector/rates";
import { syncTelemetry } from "@/collector/telemetry";

/**
 * Job schedule (all cron expressions evaluated in Europe/London):
 *
 * - telemetry      *​/10 min  — the only genuinely fresh signal (Home Mini / mock)
 * - consumption    :05 hourly — day-late data; hourly poll is generous, and
 *                               the trailing-window upsert makes it idempotent
 * - rates          06:20 + 16:20 daily — tariff rates change rarely; the
 *                               16:20 run catches day-ahead publications
 * - account        05:10 daily — catches tariff switches / meter exchanges
 *
 * Total ≲ 10 API calls/hour — far inside the ~100/hour shared account
 * budget even with the Octopus app in use.
 *
 * Jobs never overlap (a slow run skips the next tick) and never throw —
 * a failed cycle logs, records the failure in sync_state, and waits for
 * the next tick. Missed ticks self-heal because every job is cursor-based.
 */

const running = new Set<string>();

async function runJob(name: string, fn: () => Promise<void>): Promise<void> {
  if (running.has(name)) {
    console.warn(`[scheduler] ${name}: previous run still in progress, skipping tick`);
    return;
  }
  running.add(name);
  const startedAt = Date.now();
  try {
    await fn();
    setState(`job:${name}:last_success`, nowUtcIso());
    console.log(`[scheduler] ${name}: ok in ${Date.now() - startedAt}ms`);
  } catch (err) {
    setState(`job:${name}:last_error`, JSON.stringify({ at: nowUtcIso(), message: String(err) }));
    console.error(`[scheduler] ${name}: failed —`, err);
  } finally {
    running.delete(name);
  }
}

/** Run every job once, in dependency order. Used at boot and by tests. */
export async function runAllOnce(): Promise<void> {
  await runJob("account", syncAccount);
  await runJob("rates", syncRates);
  await runJob("consumption", syncConsumption);
  await runJob("telemetry", syncTelemetry);
}

const globalStore = globalThis as unknown as { __energySchedulerStarted?: boolean };

export function startScheduler(): void {
  const config = getConfig();
  if (config.mode === "setup") {
    console.log("[scheduler] setup mode — no credentials, collector idle");
    return;
  }
  if (globalStore.__energySchedulerStarted) return;
  globalStore.__energySchedulerStarted = true;

  const tz = { timezone: "Europe/London" };
  cron.schedule("*/10 * * * *", () => runJob("telemetry", syncTelemetry), tz);
  cron.schedule("5 * * * *", () => runJob("consumption", syncConsumption), tz);
  cron.schedule("20 6,16 * * *", () => runJob("rates", syncRates), tz);
  cron.schedule("10 5 * * *", () => runJob("account", syncAccount), tz);

  console.log(`[scheduler] started (${config.mode} mode)`);

  // First boot (or long downtime): populate immediately rather than waiting
  // for the next cron tick.
  const bootstrapped = getState("job:account:last_success");
  if (!bootstrapped) {
    console.log("[scheduler] first run — bootstrapping data now");
  }
  void runAllOnce();
}
