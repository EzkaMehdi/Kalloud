"use client";

import { useEffect, useState } from "react";
import { ApiError } from "./api";

/**
 * UX-01: standardizes the loading/error/success states every page needs
 * instead of each page hand-rolling its own (usually incomplete) version.
 * Deliberately has no "keep last data visible on error" behaviour — that is
 * exactly the silent-stale-data pattern the audit flagged (P0-05); a failed
 * refetch shows the error state, full stop.
 */
export type AsyncState<T> =
  { status: "loading" } | { status: "error"; message: string } | { status: "success"; data: T };

export interface UseAsyncDataResult<T> {
  state: AsyncState<T>;
  refetch: () => void;
}

export interface UseAsyncDataOptions {
  /**
   * STK-08/DEC-08: re-read when the tab comes back to the foreground.
   *
   * DEC-08 rules out live push for the MVP, so a list read once at mount
   * stays frozen while another device changes the same data — a manager
   * counting stock on a tablet leaves the till's screen quietly wrong. The
   * honest middle ground is the one `useCurrentUser` already applies to the
   * session (UX-03): focus is the last instant before someone acts on what
   * the screen shows, so it is the right moment to make sure it is true.
   *
   * Off by default: a screen that refetches must be one whose data another
   * device can change under it, and saying so per page keeps that a
   * decision rather than a habit.
   */
  revalidateOnFocus?: boolean;
}

export function useAsyncData<T>(
  fetcher: () => Promise<T>,
  deps: unknown[] = [],
  options: UseAsyncDataOptions = {},
): UseAsyncDataResult<T> {
  const [reloadToken, setReloadToken] = useState(0);
  // react-hooks/exhaustive-deps requires a literal dependency array, which a
  // generic hook accepting an arbitrary `deps` array from its caller cannot
  // provide directly; stringifying + the reload token gives one stable key
  // identifying "this particular request".
  const requestKey = `${JSON.stringify(deps)}:${reloadToken}`;

  const [state, setState] = useState<AsyncState<T>>({ status: "loading" });
  // "Adjusting state when a prop/key changes" (react.dev/learn/you-might-not-need-an-effect):
  // a render-phase conditional setState, not an effect, so switching back to
  // "loading" the instant requestKey changes does not trigger a cascading
  // effect-driven render.
  const [trackedKey, setTrackedKey] = useState(requestKey);
  if (trackedKey !== requestKey) {
    setTrackedKey(requestKey);
    setState({ status: "loading" });
  }

  useEffect(() => {
    let cancelled = false;
    fetcher()
      .then((data) => {
        if (!cancelled) setState({ status: "success", data });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const message =
          error instanceof ApiError ? error.message : "Une erreur inattendue est survenue.";
        setState({ status: "error", message });
      });
    return () => {
      cancelled = true;
    };
    // fetcher is intentionally excluded: callers pass a fresh closure on
    // every render, and re-running on every render (instead of only when
    // requestKey changes) would defeat the point of this hook.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey]);

  const revalidateOnFocus = options.revalidateOnFocus ?? false;
  useEffect(() => {
    if (!revalidateOnFocus) return;

    function revalidate() {
      // `visibilitychange` also fires on the way *out*; only the return
      // matters, and refetching a hidden tab would spend a request nobody
      // is waiting for.
      if (document.visibilityState === "visible") setReloadToken((token) => token + 1);
    }

    window.addEventListener("focus", revalidate);
    document.addEventListener("visibilitychange", revalidate);
    return () => {
      window.removeEventListener("focus", revalidate);
      document.removeEventListener("visibilitychange", revalidate);
    };
  }, [revalidateOnFocus]);

  return { state, refetch: () => setReloadToken((token) => token + 1) };
}
