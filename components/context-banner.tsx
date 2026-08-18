"use client";

/**
 * BI-05: "le gérant connaît toujours le périmètre des chiffres" — the four
 * facts DEC-09 says every KPI must be answerable against (source aside,
 * that one is the dictionary's job, not the screen's): which establishment,
 * over what period, whether a service is currently open, and how fresh the
 * numbers on screen actually are. Presented together, always, rather than
 * left for a reader to infer from a page title and a selector's current
 * position.
 */
const timeFormatter = new Intl.DateTimeFormat("fr-FR", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

export function ContextBanner({
  establishmentName,
  periodLabel,
  serviceOpen,
  lastSyncedAt,
}: {
  /** `null` while `/api/settings` has not resolved yet. */
  establishmentName: string | null;
  periodLabel: string;
  /** `null` while `/api/cash-summary` has not resolved yet — deliberately distinct from `false`. */
  serviceOpen: boolean | null;
  /** `null` before the first successful fetch this screen has made. */
  lastSyncedAt: Date | null;
}) {
  return (
    <div className="context-banner" role="status" aria-live="polite">
      <span className="context-item context-establishment">{establishmentName ?? "…"}</span>
      <span className="context-item">{periodLabel}</span>
      <span className={`status context-item ${serviceOpen ? "" : "muted"}`}>
        <span className="dot" aria-hidden="true" />
        {serviceOpen === null ? "…" : serviceOpen ? "Service ouvert" : "Aucun service ouvert"}
      </span>
      <span className="context-item context-sync">
        {lastSyncedAt
          ? `Synchronisé à ${timeFormatter.format(lastSyncedAt)}`
          : "Synchronisation en cours…"}
      </span>
    </div>
  );
}
