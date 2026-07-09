"use client";

import { useEffect, useState } from "react";
import { todayLocal } from "@/lib/time";
import type { ApiError } from "@/lib/types";

/**
 * Shared polling fetch hook for the dashboard's JSON APIs.
 *
 * - Refetches every `intervalMs` (default 10 minutes) and keeps polling after
 *   an error — a transient collector hiccup must not freeze the UI.
 * - Holds the previous `data` while a SAME-path refetch is in flight, so
 *   charts dim rather than flash a skeleton. A path CHANGE clears `data`:
 *   the old payload belongs to a different selection and rendering it under
 *   the new labels (e.g. electricity numbers on the Gas tab) is worse than
 *   a skeleton.
 * - `path: null` disables the hook (used when a meter is absent).
 */

export interface UseApiResult<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  /** UTC ISO of the last successful fetch, null before the first one. */
  refreshedAt: string | null;
}

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;

export function useApi<T>(
  path: string | null,
  intervalMs: number = DEFAULT_INTERVAL_MS
): UseApiResult<T> {
  const [state, setState] = useState<UseApiResult<T>>({
    data: null,
    error: null,
    loading: path !== null,
    refreshedAt: null,
  });

  useEffect(() => {
    if (path === null) {
      setState({ data: null, error: null, loading: false, refreshedAt: null });
      return;
    }
    let cancelled = false;

    const load = async () => {
      try {
        const res = await fetch(path, { cache: "no-store" });
        const body = (await res.json()) as unknown;
        if (cancelled) return;
        if (!res.ok) {
          const message =
            typeof (body as ApiError)?.error === "string"
              ? (body as ApiError).error
              : `request failed (HTTP ${res.status})`;
          setState((prev) => ({ ...prev, error: message, loading: false }));
          return;
        }
        setState({
          data: body as T,
          error: null,
          loading: false,
          refreshedAt: new Date().toISOString(),
        });
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : "request failed";
        setState((prev) => ({ ...prev, error: message, loading: false }));
      }
    };

    // This effect body runs only on mount and path/interval changes — never
    // on same-path polls (those go through setInterval below) — so clearing
    // here drops exactly the cross-path stale data.
    setState({ data: null, error: null, loading: true, refreshedAt: null });
    void load();
    const id = setInterval(() => void load(), intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [path, intervalMs]);

  return state;
}

/**
 * The current Europe/London calendar date, updating while mounted — an
 * always-on dashboard must roll its "today"/"yesterday" ranges at midnight
 * rather than freezing them at mount time.
 */
export function useLocalToday(): string {
  const [today, setToday] = useState(() => todayLocal());
  useEffect(() => {
    const id = setInterval(() => {
      const current = todayLocal();
      setToday((prev) => (prev === current ? prev : current));
    }, 60_000);
    return () => clearInterval(id);
  }, []);
  return today;
}
