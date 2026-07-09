import { getCurrentRates } from "@/lib/aggregate";
import { nowUtcIso } from "@/lib/time";
import type { RatesResponse } from "@/lib/types";
import { isSetupModeError, respond } from "@/app/api/_lib/params";

/** GET /api/rates — current unit rate + standing charge per meter point. */

export const dynamic = "force-dynamic";

export function GET(): Response {
  return respond<RatesResponse>(() => {
    try {
      return getCurrentRates();
    } catch (err) {
      if (!isSetupModeError(err)) throw err;
      return { rates: [], generatedAt: nowUtcIso() };
    }
  });
}
