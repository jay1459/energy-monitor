import { DateTime } from "luxon";
import { LONDON } from "@/lib/time";
import type { Fuel } from "@/lib/types";

/**
 * Display formatting. Money arrives as pence inc VAT and renders as pounds;
 * energy is kWh at 1–2 dp; all times render in Europe/London.
 */

/** Pence -> "£12.34" (or "-£3.21"). */
export function pounds(pence: number): string {
  const sign = pence < 0 ? "-" : "";
  return `${sign}£${(Math.abs(pence) / 100).toFixed(2)}`;
}

/** Pence -> "£12" — for axis ticks, where clean numbers beat precision. */
export function poundsTick(pence: number): string {
  const sign = pence < 0 ? "-" : "";
  return `${sign}£${Math.round(Math.abs(pence) / 100)}`;
}

/** kWh at 1–2 dp: 0.75, 8.4, 123.4. */
export function kwh(value: number): string {
  const dp = Math.abs(value) >= 10 ? 1 : 2;
  return `${value.toFixed(dp)} kWh`;
}

/** Instantaneous demand: "412 W" or "1.24 kW". */
export function watts(w: number): string {
  return Math.abs(w) >= 1000
    ? `${(w / 1000).toFixed(2)} kW`
    : `${Math.round(w)} W`;
}

/** Unit rate / standing charge: "24.50p/kWh", "60.10p/day". */
export function penceRate(pence: number, per: "kWh" | "day"): string {
  return `${pence.toFixed(2)}p/${per}`;
}

/** Local "yyyy-MM-dd" -> "Mon 7 Jul". */
export function dayLabel(localDate: string): string {
  return DateTime.fromISO(localDate, { zone: LONDON }).toFormat("EEE d LLL");
}

/** Local "yyyy-MM-dd" -> "7 Jul". */
export function shortDayLabel(localDate: string): string {
  return DateTime.fromISO(localDate, { zone: LONDON }).toFormat("d LLL");
}

/** Local "yyyy-MM-dd" -> "Jul 2026" (month buckets). */
export function monthLabel(localDate: string): string {
  return DateTime.fromISO(localDate, { zone: LONDON }).toFormat("LLL yyyy");
}

/** UTC instant -> "14:30" Europe/London. */
export function clockLabel(utcIso: string): string {
  return DateTime.fromISO(utcIso, { setZone: true })
    .setZone(LONDON)
    .toFormat("HH:mm");
}

/** UTC instant -> "Mon 7 Jul, 14:30" Europe/London. */
export function instantLabel(utcIso: string): string {
  return DateTime.fromISO(utcIso, { setZone: true })
    .setZone(LONDON)
    .toFormat("EEE d LLL, HH:mm");
}

/** Display name for a meter point / rate row. */
export function fuelLabel(fuel: Fuel, isExport: boolean): string {
  if (isExport) return "Solar export";
  return fuel === "electricity" ? "Electricity" : "Gas";
}
