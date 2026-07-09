/**
 * Next.js instrumentation hook — starts the collector's cron scheduler
 * inside the server process. Guarded against dev-server re-registration
 * in scheduler.ts via globalThis.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startScheduler } = await import("@/collector/scheduler");
    startScheduler();
  }
}
