"use client";

import { RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import type { AsyncState } from "@/lib/client/use-async-data";

export interface AsyncSectionProps<T> {
  state: AsyncState<T>;
  onRetry?: () => void;
  /** Return true when `data` should render the empty state instead of `children`. */
  isEmpty?: (data: T) => boolean;
  emptyMessage?: string;
  loadingLabel?: string;
  children: (data: T) => ReactNode;
}

/**
 * UX-01's single rendering of loading/error/empty/success so every page
 * looks and behaves the same way instead of five different bespoke
 * (and frequently silent) failure modes.
 */
export function AsyncSection<T>({
  state,
  onRetry,
  isEmpty,
  emptyMessage = "Aucune donnée pour le moment.",
  loadingLabel = "Chargement…",
  children,
}: AsyncSectionProps<T>) {
  if (state.status === "loading") {
    return (
      <div className="async-state" role="status" aria-live="polite">
        <span className="spinner" aria-hidden="true" />
        {loadingLabel}
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="async-state async-state-error" role="alert">
        <p>{state.message}</p>
        {onRetry && (
          <button type="button" className="soft-button" onClick={onRetry}>
            <RefreshCw size={16} />
            Réessayer
          </button>
        )}
      </div>
    );
  }

  if (isEmpty?.(state.data)) {
    return (
      <div className="async-state" role="status">
        {emptyMessage}
      </div>
    );
  }

  return <>{children(state.data)}</>;
}
