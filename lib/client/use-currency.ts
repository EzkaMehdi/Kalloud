"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "./api";

/**
 * CFG-01/GATE-4B: "devise réellement appliquée".
 *
 * Every screen used to append " €" by hand, which made the configurable
 * `location_settings.currency` a field with no effect — exactly the kind of
 * setting that looks like it works until someone changes it. This reads the
 * establishment's currency once and hands back a formatter.
 *
 * Falls back to EUR while the request is in flight or if it fails: a price
 * with no symbol is worse than a price with the pilot's own, and the
 * settings screen itself will show the real value either way.
 */
export function useCurrencyFormatter(): (value: string | number) => string {
  const [currency, setCurrency] = useState("EUR");

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ settings: { currency: string } }>("/api/settings")
      .then((configuration) => {
        if (!cancelled) setCurrency(configuration.settings.currency);
      })
      .catch(() => {
        // Keeping the fallback is the honest degradation here; the screens
        // that matter for money (settings, receipt) state it explicitly.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (value: string | number) =>
    new Intl.NumberFormat("fr-FR", { style: "currency", currency }).format(Number(value));
}
