import { NextResponse } from "next/server";
import { z } from "zod";
import { addLocalDays, parseLocalDate, todayLocal } from "@/lib/time";
import type { ApiError, Fuel, Resolution } from "@/lib/types";

/**
 * Shared query-param parsing and response plumbing for the API routes.
 * Parsers throw BadRequestError (mapped to 400 by `respond`); anything else
 * thrown inside `respond` becomes a 500. Setup mode is not an error for the
 * read API — routes catch errors matching `isSetupModeError` and degrade to
 * empty payloads so the dashboard can render its setup instructions.
 */

/** Longest permitted from..to span, inclusive of both endpoints. */
const MAX_RANGE_DAYS = 400;

export class BadRequestError extends Error {}

const localDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((d) => {
    try {
      parseLocalDate(d);
      return true;
    } catch {
      return false;
    }
  });

const fuelSchema = z.enum(["electricity", "gas"]);
const resolutionSchema = z.enum(["halfhour", "day", "week", "month"]);
const flagSchema = z.enum(["0", "1"]);

function parseWith<T>(schema: z.ZodType<T>, value: string, name: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestError(`invalid ${name}: ${value}`);
  return result.data;
}

/**
 * Local-date range from `from`/`to` params. Defaults: `to` = today
 * (Europe/London), `from` = `to` - (defaultSpanDays - 1), i.e. an inclusive
 * window of defaultSpanDays days ending today.
 */
export function parseDateRange(
  params: URLSearchParams,
  defaultSpanDays: number
): { from: string; to: string } {
  const toParam = params.get("to");
  const to = toParam === null ? todayLocal() : parseWith(localDateSchema, toParam, "to");
  const fromParam = params.get("from");
  const from =
    fromParam === null
      ? addLocalDays(to, -(defaultSpanDays - 1))
      : parseWith(localDateSchema, fromParam, "from");
  if (from > to) {
    throw new BadRequestError(`from (${from}) is after to (${to})`);
  }
  // "yyyy-MM-dd" compares lexicographically, so string > is a date test.
  if (to > addLocalDays(from, MAX_RANGE_DAYS - 1)) {
    throw new BadRequestError(`date range exceeds ${MAX_RANGE_DAYS} days`);
  }
  return { from, to };
}

export function parseFuel(params: URLSearchParams): Fuel {
  const value = params.get("fuel");
  return value === null ? "electricity" : parseWith(fuelSchema, value, "fuel");
}

/** `export=1` selects the export meter; absent or `0` = import. */
export function parseExportFlag(params: URLSearchParams): boolean {
  const value = params.get("export");
  return value === null ? false : parseWith(flagSchema, value, "export") === "1";
}

export function parseResolution(params: URLSearchParams): Resolution {
  const value = params.get("resolution");
  return value === null ? "day" : parseWith(resolutionSchema, value, "resolution");
}

/** True for the "no data source in setup mode" error family from lib code. */
export function isSetupModeError(err: unknown): boolean {
  return err instanceof Error && /setup mode/i.test(err.message);
}

/** Run a synchronous payload builder, mapping throws to 400/500 ApiError. */
export function respond<T>(build: () => T): NextResponse<T | ApiError> {
  try {
    return NextResponse.json(build());
  } catch (err) {
    if (err instanceof BadRequestError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error("[api]", err);
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
