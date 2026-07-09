# Energy Monitor

Self-hosted dashboard for a UK Octopus Energy home: electricity import, gas,
and solar export, with cost tracking that reproduces Octopus billing.

## Quick start

```bash
npm install

# Demo with synthetic data (no credentials needed):
echo ENERGY_MOCK=1 > .env.local
npm run dev
# open http://localhost:3000

# Real data:
copy .env.example .env.local   # then fill in:
#   OCTOPUS_API_KEY        octopus.energy dashboard -> Personal details -> Developer settings
#   OCTOPUS_ACCOUNT_NUMBER A-XXXXXXXX (top of any bill)
```

On first boot the collector discovers your meters from the account API and
backfills up to 3 years of half-hourly history, then keeps itself current on
a cron schedule inside the Next.js server process. The dashboard refreshes
every 10 minutes from the local SQLite database.

> For half-hourly data you must have smart-meter half-hourly data sharing
> enabled in your Octopus dashboard (Personal details → Smart meter data).

## What to expect from the data (this is Octopus, not us)

- **Half-hourly is the finest granularity** the Octopus REST API provides,
  and readings arrive **roughly a day late** (nightly DCC batch, no SLA).
  The dashboard shows per-fuel "complete through" freshness so this is
  never mistaken for missing data.
- **A live view needs an Octopus Home Mini** (free device, SMETS2 meters
  only). Once one is on your account the telemetry job picks it up
  automatically (or set `HOME_MINI_DEVICE_ID`); electricity then updates
  minute-level, gas stays 30-minute.
- Historical readings get **revised** — the collector re-fetches a trailing
  14-day window and recomputes affected days' costs.
- Computed costs use Octopus's own billing rules (0.01 kWh half-to-even
  rounding, VAT-inclusive rates, payment-method-specific prices, standing
  charge per Europe/London calendar day) and should match bills to the
  penny on Fixed/Flexible tariffs. Saving Sessions / one-off credits are
  out of scope and will show as small divergences in event months.

## Architecture

```
src/
  collector/          cron jobs (node-cron, started via instrumentation.ts)
    bootstrap.ts        account -> meters/serials/agreements   (daily 05:10)
    consumption.ts      half-hourly upsert + trailing re-scan  (hourly :05)
    rates.ts            unit rates + standing charges          (06:20, 16:20)
    telemetry.ts        Home Mini live data                    (every 10 min)
  lib/
    octopus/            REST + GraphQL clients, mock data source
    db.ts               SQLite (WAL) schema + connection
    costs.ts            billing-faithful cost engine
    aggregate.ts        read-side queries for the API routes
    time.ts             Europe/London helpers (DST-safe: 46/48/50 half-hour days)
  app/
    api/                JSON API consumed by the dashboard
    (pages)             Overview / Usage / Costs
```

Storage is a single SQLite file (`data/energy.db`, WAL mode). Volumes are
tiny — ~17.5k half-hour rows per meter per year — so back it up by copying
the file (stop the server, or use `sqlite3 .backup`).

## Gas units

SMETS2 gas meters report m³, SMETS1 report kWh, and the API response does
not say which. `GAS_UNIT=auto` infers it once from reading magnitudes; if
your gas numbers look ~10× off, set `GAS_UNIT` explicitly and delete
`data/energy.db` to re-ingest. `GAS_CALORIFIC_VALUE` is on your gas bill.

## Commands

```bash
npm run dev     # dev server + collector
npm run build   # production build
npm start       # production server + collector
npm test        # vitest (cost engine + aggregation)
```
