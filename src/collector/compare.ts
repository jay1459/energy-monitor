import { upsertStandingCharges, upsertUnitRates } from "@/collector/rates";
import { getDb, getState, setState } from "@/lib/db";
import { getDataSource } from "@/lib/octopus/source";
import { normalizeInstant, nowUtc, nowUtcIso, parseInstant, utcIso } from "@/lib/time";
import type { Fuel } from "@/lib/types";

/**
 * Candidate-tariff rate sync for the /compare page.
 *
 * Daily job: discover the CURRENT comparable Octopus import products from
 * the public products API, derive region-specific tariff codes from the
 * household's own tariff (the trailing region letter), and store their unit
 * rates + standing charges in unit_rates/standing_charges via the shared
 * upsert helpers exported by src/collector/rates.ts.
 *
 * - Candidates: latest available products whose code starts with "AGILE-"
 *   (electricity only) or "SILVER-" (Tracker; electricity and gas),
 *   direction IMPORT, brand OCTOPUS_ENERGY. One product per prefix family —
 *   the newest available_from. A family with no available product is
 *   skipped, not an error.
 * - Tariff codes: E-1R-<product>-<region> / G-1R-<product>-<region>, region
 *   letter taken from the current agreement's tariff code suffix.
 * - Rate window: from the oldest stored consumption interval to now+2d,
 *   fetched incrementally with the same per-tariff watermark scheme as
 *   rates.ts ("rates_synced_through:<tariff>|<from>" keys, 7-day overlap).
 *   The <from> is the oldest-consumption anchor: deeper backfill moves it,
 *   minting a fresh watermark and a refetch — fine, the upserts are
 *   idempotent. Agile history is ~48 rows/day — a year is a couple of pages
 *   at page_size 1500.
 * - Writes sync_state "compare_candidates" = JSON array of
 *   { productCode, displayName, fuel, tariffCode } and
 *   "compare_candidates_synced_at" = now (canonical UTC) covering every
 *   candidate that synced (a partial failure must not blank /compare).
 * - The products catalogue endpoint is public (no auth) and NOT part of
 *   EnergyDataSource; in mock mode discovery is skipped in favor of the
 *   fixed candidates the MockSource generates rates for (AGILE-24-10-01 and
 *   SILVER-25-04-01 — see lib/octopus/mock.ts) with no network at all.
 * - No agreements or no consumption yet — skip quietly (nothing to anchor
 *   or regionalize). Per-candidate failures are collected and rethrown as
 *   one aggregate at the end, like rates.ts, so the scheduler records them
 *   without one candidate breaking the others.
 */

const INCREMENTAL_OVERLAP_DAYS = 7;
const PRODUCTS_URL =
  "https://api.octopus.energy/v1/products/?brand=OCTOPUS_ENERGY&is_business=false";
const FETCH_TIMEOUT_MS = 30_000;

interface CandidateProduct {
  code: string;
  displayName: string;
}

/** Shape persisted to sync_state "compare_candidates" (read by lib/compare.ts). */
interface Candidate {
  productCode: string;
  displayName: string;
  fuel: Fuel;
  tariffCode: string;
}

interface ApiProduct {
  code: string;
  direction: string;
  full_name: string | null;
  display_name: string | null;
  available_from: string | null;
  available_to: string | null;
}

/** Whole public products catalogue, following pagination. */
async function fetchProductCatalogue(): Promise<ApiProduct[]> {
  const out: ApiProduct[] = [];
  let url: string | null = PRODUCTS_URL;
  while (url) {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`products catalogue HTTP ${res.status} (${url})`);
    const page = (await res.json()) as { next: string | null; results: ApiProduct[] };
    out.push(...page.results);
    url = page.next;
  }
  return out;
}

/**
 * Newest still-available IMPORT product whose code starts with the prefix,
 * or null when the family has none. "Available" = available_to null or in
 * the future; "newest" = greatest available_from.
 */
function pickNewestProduct(
  products: ApiProduct[],
  prefix: string,
  nowIso: string
): CandidateProduct | null {
  let best: ApiProduct | null = null;
  let bestFrom = "";
  for (const p of products) {
    if (p.direction !== "IMPORT" || !p.code.startsWith(prefix)) continue;
    let availTo: string | null;
    let availFrom: string;
    try {
      // The catalogue mixes offsets like the rest of the API — normalize
      // before comparing; a product with garbage dates is just skipped.
      availTo = p.available_to === null ? null : normalizeInstant(p.available_to);
      availFrom = p.available_from === null ? "" : normalizeInstant(p.available_from);
    } catch {
      continue;
    }
    if (availTo !== null && availTo <= nowIso) continue;
    if (!best || availFrom > bestFrom) {
      best = p;
      bestFrom = availFrom;
    }
  }
  if (!best) return null;
  return { code: best.code, displayName: best.display_name || best.full_name || best.code };
}

export async function syncCompareCandidates(): Promise<void> {
  const db = getDb();

  // Region context comes from the household's own tariff-code suffix.
  const anyAgreement = db
    .prepare(
      `SELECT a.tariff_code AS tariffCode
         FROM agreements a JOIN meter_points m ON m.id = a.meter_point_id
        LIMIT 1`
    )
    .get() as { tariffCode: string } | undefined;
  if (!anyAgreement) {
    console.log("[compare] no agreements yet — skipping candidate sync");
    return;
  }
  const regionMatch = /-([A-P])$/.exec(anyAgreement.tariffCode);
  if (!regionMatch) {
    throw new Error(`cannot derive region letter from tariff code: ${anyAgreement.tariffCode}`);
  }
  const region = regionMatch[1];

  // Rate-window anchor: the oldest half-hour a candidate could ever price.
  const oldest = (
    db
      .prepare(
        `SELECT MIN(c.interval_start) AS oldest
           FROM consumption c JOIN meter_points m ON m.id = c.meter_point_id
          WHERE m.is_export = 0`
      )
      .get() as { oldest: string | null }
  ).oldest;
  if (!oldest) {
    console.log("[compare] no consumption stored yet — skipping candidate sync");
    return;
  }

  const fuels = new Set(
    (
      db
        .prepare("SELECT DISTINCT fuel FROM meter_points WHERE is_export = 0")
        .all() as { fuel: Fuel }[]
    ).map((r) => r.fuel)
  );

  const source = await getDataSource();
  const nowIso = nowUtcIso();

  let agile: CandidateProduct | null;
  let silver: CandidateProduct | null;
  if (source.kind === "mock") {
    // Fixed candidates the MockSource generates rates for; no network.
    agile = { code: "AGILE-24-10-01", displayName: "Agile Octopus" };
    silver = { code: "SILVER-25-04-01", displayName: "Octopus Tracker" };
  } else {
    const products = await fetchProductCatalogue();
    agile = pickNewestProduct(products, "AGILE-", nowIso);
    silver = pickNewestProduct(products, "SILVER-", nowIso);
    if (!agile) console.warn("[compare] no available AGILE- import product — family skipped");
    if (!silver) console.warn("[compare] no available SILVER- import product — family skipped");
  }

  const candidates: Candidate[] = [];
  if (agile && fuels.has("electricity")) {
    candidates.push({
      productCode: agile.code,
      displayName: agile.displayName,
      fuel: "electricity",
      tariffCode: `E-1R-${agile.code}-${region}`,
    });
  }
  if (silver && fuels.has("electricity")) {
    candidates.push({
      productCode: silver.code,
      displayName: silver.displayName,
      fuel: "electricity",
      tariffCode: `E-1R-${silver.code}-${region}`,
    });
  }
  if (silver && fuels.has("gas")) {
    candidates.push({
      productCode: silver.code,
      displayName: silver.displayName,
      fuel: "gas",
      tariffCode: `G-1R-${silver.code}-${region}`,
    });
  }
  if (candidates.length === 0) {
    console.log("[compare] no comparable products for this account — nothing to sync");
    return;
  }

  const horizon = utcIso(nowUtc().plus({ days: 2 }));
  const errors: string[] = [];
  const synced: Candidate[] = [];

  for (const c of candidates) {
    try {
      const watermarkKey = `rates_synced_through:${c.tariffCode}|${oldest}`;
      const watermark = getState(watermarkKey);
      const fromUtc = watermark
        ? maxInstant(
            oldest,
            utcIso(parseInstant(watermark).minus({ days: INCREMENTAL_OVERLAP_DAYS }))
          )
        : oldest;

      const rates = await source.getUnitRates(
        c.productCode,
        c.tariffCode,
        c.fuel,
        "standard",
        fromUtc,
        horizon
      );
      upsertUnitRates(db, c.tariffCode, "standard", rates);
      const standing = await source.getStandingCharges(
        c.productCode,
        c.tariffCode,
        c.fuel,
        fromUtc,
        horizon
      );
      upsertStandingCharges(db, c.tariffCode, standing);

      setState(watermarkKey, horizon);
      synced.push(c);
      console.log(
        `[compare] ${c.tariffCode}: ${rates.length} unit rate row(s) + ` +
          `${standing.length} standing charge row(s) from ${fromUtc}`
      );
    } catch (err) {
      console.error(`[compare] ${c.tariffCode}: sync failed —`, err);
      errors.push(`${c.tariffCode}: ${String(err)}`);
    }
  }

  // Publish whichever candidates synced — a partial failure must not blank
  // the compare page, nor drop a previously-published candidate whose older
  // (still usable) rates sit in the DB. Only a fully successful run replaces
  // the list outright, which is what retires superseded products.
  if (synced.length > 0) {
    let published = synced;
    if (errors.length > 0) {
      const prior = readPublishedCandidates();
      const byTariff = new Map(prior.map((c) => [c.tariffCode, c]));
      for (const c of synced) byTariff.set(c.tariffCode, c);
      published = [...byTariff.values()];
    }
    setState("compare_candidates", JSON.stringify(published));
    setState("compare_candidates_synced_at", nowUtcIso());
  }

  if (errors.length > 0) {
    throw new Error(
      `compare candidate sync failed for ${errors.length}/${candidates.length} candidate(s): ` +
        errors.join(" | ")
    );
  }
}

/** Previously-published candidate list; empty before the first sync (or on garbage). */
function readPublishedCandidates(): Candidate[] {
  const raw = getState("compare_candidates");
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (c): c is Candidate =>
        typeof c === "object" &&
        c !== null &&
        typeof (c as Candidate).tariffCode === "string" &&
        typeof (c as Candidate).productCode === "string" &&
        typeof (c as Candidate).displayName === "string" &&
        ((c as Candidate).fuel === "electricity" || (c as Candidate).fuel === "gas")
    );
  } catch {
    return [];
  }
}

function maxInstant(a: string, b: string): string {
  return a > b ? a : b;
}
