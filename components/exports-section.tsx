/**
 * BI-12/DEC-09: one download link per validated export domain (ventes,
 * paiements, caisse, stock) — a plain `<a>`, not a `fetch` + blob dance:
 * the route already carries the session cookie on a same-origin GET, and
 * `Content-Disposition: attachment` (`lib/http.ts::csvOk`) is what makes
 * the browser save the response instead of trying to render `text/csv`
 * inline. No client state, so no "use client" directive needed.
 *
 * BI-14: `period`/`year`/`month` — the same props `PerformanceComparisonBlock`
 * and `SalesTrendsBlock` already take — are appended to every link's own
 * query string, so "Ventes" while the cockpit shows "Ce mois" downloads
 * exactly that month, not the establishment's whole history (`GATE-6`,
 * "l'export respecte exactement les filtres").
 */
export function ExportsSection({
  period,
  year,
  month,
}: {
  period: "service" | "month" | "year";
  year: number;
  month: number;
}) {
  const params = new URLSearchParams({ period });
  if (period === "month") {
    params.set("year", String(year));
    params.set("month", String(month));
  } else if (period === "year") {
    params.set("year", String(year));
  }
  const query = params.toString();

  return (
    <>
      <div className="section-title">
        <div>
          <h2>Exports</h2>
          <p className="eyebrow">Ventes, paiements, caisse et stock, au format CSV</p>
        </div>
      </div>
      <div className="exports-row">
        <a className="outline-button" href={`/api/exports/sales?${query}`}>
          Ventes
        </a>
        <a className="outline-button" href={`/api/exports/payments?${query}`}>
          Paiements
        </a>
        <a className="outline-button" href={`/api/exports/cash?${query}`}>
          Caisse
        </a>
        <a className="outline-button" href={`/api/exports/stock?${query}`}>
          Stock
        </a>
      </div>
    </>
  );
}
