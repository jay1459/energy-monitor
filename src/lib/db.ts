import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { getConfig } from "@/lib/config";

/**
 * SQLite connection singleton. WAL mode so the collector (writer) and the
 * dashboard's API routes (readers) coexist in one process without blocking.
 * Cached on globalThis to survive Next.js dev-server module reloads.
 */

const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meter_points (
  id INTEGER PRIMARY KEY,
  fuel TEXT NOT NULL CHECK (fuel IN ('electricity','gas')),
  identifier TEXT NOT NULL UNIQUE,
  is_export INTEGER NOT NULL DEFAULT 0,
  unit TEXT NOT NULL DEFAULT 'kwh' CHECK (unit IN ('kwh','m3')),
  active_serial TEXT,
  label TEXT
);

CREATE TABLE IF NOT EXISTS meter_serials (
  meter_point_id INTEGER NOT NULL REFERENCES meter_points(id),
  serial TEXT NOT NULL,
  PRIMARY KEY (meter_point_id, serial)
);

CREATE TABLE IF NOT EXISTS agreements (
  meter_point_id INTEGER NOT NULL REFERENCES meter_points(id),
  tariff_code TEXT NOT NULL,
  product_code TEXT NOT NULL,
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  PRIMARY KEY (meter_point_id, tariff_code, valid_from)
);

CREATE TABLE IF NOT EXISTS consumption (
  meter_point_id INTEGER NOT NULL REFERENCES meter_points(id),
  interval_start TEXT NOT NULL,
  interval_end TEXT NOT NULL,
  value_raw REAL NOT NULL,
  kwh REAL NOT NULL,
  fetched_at TEXT NOT NULL,
  revised_at TEXT,
  PRIMARY KEY (meter_point_id, interval_start)
);
CREATE INDEX IF NOT EXISTS idx_consumption_start ON consumption(interval_start);

CREATE TABLE IF NOT EXISTS unit_rates (
  tariff_code TEXT NOT NULL,
  rate_type TEXT NOT NULL DEFAULT 'standard' CHECK (rate_type IN ('standard','day','night')),
  payment_method TEXT NOT NULL DEFAULT '',
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  p_exc_vat REAL NOT NULL,
  p_inc_vat REAL NOT NULL,
  PRIMARY KEY (tariff_code, rate_type, payment_method, valid_from)
);

CREATE TABLE IF NOT EXISTS standing_charges (
  tariff_code TEXT NOT NULL,
  payment_method TEXT NOT NULL DEFAULT '',
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  p_exc_vat REAL NOT NULL,
  p_inc_vat REAL NOT NULL,
  PRIMARY KEY (tariff_code, payment_method, valid_from)
);

CREATE TABLE IF NOT EXISTS telemetry (
  device_id TEXT NOT NULL,
  read_at TEXT NOT NULL,
  demand_w REAL,
  consumption_wh REAL,
  export_wh REAL,
  consumption_delta_wh REAL,
  cost_delta_p REAL,
  PRIMARY KEY (device_id, read_at)
);
-- getLive() sorts/filters on read_at alone; the composite PK can't serve that.
CREATE INDEX IF NOT EXISTS idx_telemetry_read_at ON telemetry(read_at);

CREATE TABLE IF NOT EXISTS daily_costs (
  meter_point_id INTEGER NOT NULL REFERENCES meter_points(id),
  local_date TEXT NOT NULL,
  kwh REAL NOT NULL,
  intervals_present INTEGER NOT NULL,
  intervals_expected INTEGER NOT NULL,
  intervals_priced INTEGER NOT NULL DEFAULT 0,
  energy_p REAL NOT NULL,
  standing_p REAL NOT NULL,
  total_p REAL NOT NULL,
  computed_at TEXT NOT NULL,
  PRIMARY KEY (meter_point_id, local_date)
);

CREATE TABLE IF NOT EXISTS sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

function open(): Database.Database {
  const config = getConfig();
  const dbPath = path.resolve(process.cwd(), config.dbPath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");

  const version = db.pragma("user_version", { simple: true }) as number;
  if (version < SCHEMA_VERSION) {
    db.exec(SCHEMA); // idempotent baseline (IF NOT EXISTS throughout)
    if (version === 1) {
      // v1 -> v2: daily_costs gained intervals_priced (CREATE TABLE IF NOT
      // EXISTS skips existing tables, so upgrade explicitly).
      const cols = db.pragma("table_info(daily_costs)") as { name: string }[];
      if (!cols.some((c) => c.name === "intervals_priced")) {
        db.exec(
          "ALTER TABLE daily_costs ADD COLUMN intervals_priced INTEGER NOT NULL DEFAULT 0"
        );
      }
    }
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }
  return db;
}

const globalStore = globalThis as unknown as { __energyDb?: Database.Database };

export function getDb(): Database.Database {
  if (!globalStore.__energyDb) {
    globalStore.__energyDb = open();
  }
  return globalStore.__energyDb;
}

// --- sync_state helpers (cursors, cached tokens, job bookkeeping) ----------

export function getState(key: string): string | null {
  const row = getDb()
    .prepare("SELECT value FROM sync_state WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setState(key: string, value: string): void {
  getDb()
    .prepare(
      "INSERT INTO sync_state (key, value) VALUES (?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    )
    .run(key, value);
}

export function deleteState(key: string): void {
  getDb().prepare("DELETE FROM sync_state WHERE key = ?").run(key);
}
