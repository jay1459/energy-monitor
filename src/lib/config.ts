import { z } from "zod";
import type { AppMode } from "@/lib/types";

/**
 * Environment configuration. The app must boot without credentials (setup
 * mode renders instructions), so nothing here throws on missing values —
 * `mode` tells the rest of the app what is possible.
 */

const envSchema = z.object({
  OCTOPUS_API_KEY: z.string().trim().min(1).optional(),
  OCTOPUS_ACCOUNT_NUMBER: z.string().trim().min(1).optional(),
  /** Filter for duplicate rate rows on variable tariffs. */
  OCTOPUS_PAYMENT_METHOD: z
    .enum(["DIRECT_DEBIT", "NON_DIRECT_DEBIT"])
    .default("DIRECT_DEBIT"),
  /** MJ/m³ — from a gas bill; used for SMETS2 m³→kWh conversion. */
  GAS_CALORIFIC_VALUE: z.coerce.number().positive().default(39.5),
  /**
   * Unit of raw gas readings. SMETS2 meters report m³, SMETS1 report kWh.
   * "auto" lets the collector infer from reading magnitudes and can be
   * overridden once known (it is printed on the bill).
   */
  GAS_UNIT: z.enum(["auto", "kwh", "m3"]).default("auto"),
  /** Set to enable the Home Mini telemetry job once the device arrives. */
  HOME_MINI_DEVICE_ID: z.string().trim().min(1).optional(),
  ENERGY_DB_PATH: z.string().default("data/energy.db"),
  /** "1" = synthetic data source; no credentials or network needed. */
  ENERGY_MOCK: z.string().optional(),
});

export interface AppConfig {
  mode: AppMode;
  apiKey: string | null;
  accountNumber: string | null;
  paymentMethod: "DIRECT_DEBIT" | "NON_DIRECT_DEBIT";
  gasCalorificValue: number;
  gasUnit: "auto" | "kwh" | "m3";
  homeMiniDeviceId: string | null;
  dbPath: string;
}

/** Mock data must never touch the live database file. */
function mockDbPath(dbPath: string): string {
  return dbPath.endsWith(".db") ? dbPath.replace(/\.db$/, ".mock.db") : `${dbPath}.mock`;
}

function load(): AppConfig {
  // .env templates leave unused vars as KEY= (empty string), which must mean
  // "unset" — zod's min(1)/enum/coerce checks would otherwise reject them and
  // a single blank line would discard the whole environment.
  const raw = Object.fromEntries(
    Object.entries(process.env).filter(([, v]) => v !== undefined && v !== "")
  );
  const parsed = envSchema.safeParse(raw);
  const env = parsed.success ? parsed.data : envSchema.parse({});
  if (!parsed.success) {
    console.warn(
      "[config] invalid environment values, falling back to defaults:",
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
    );
  }

  const mock = env.ENERGY_MOCK === "1" || env.ENERGY_MOCK === "true";
  const mode: AppMode = mock
    ? "mock"
    : env.OCTOPUS_API_KEY && env.OCTOPUS_ACCOUNT_NUMBER
      ? "live"
      : "setup";

  return {
    mode,
    apiKey: env.OCTOPUS_API_KEY ?? null,
    accountNumber: env.OCTOPUS_ACCOUNT_NUMBER ?? null,
    paymentMethod: env.OCTOPUS_PAYMENT_METHOD,
    gasCalorificValue: env.GAS_CALORIFIC_VALUE,
    gasUnit: env.GAS_UNIT,
    homeMiniDeviceId: env.HOME_MINI_DEVICE_ID ?? null,
    dbPath: mock ? mockDbPath(env.ENERGY_DB_PATH) : env.ENERGY_DB_PATH,
  };
}

let cached: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (!cached) cached = load();
  return cached;
}
