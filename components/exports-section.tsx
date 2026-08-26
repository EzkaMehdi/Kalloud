/**
 * BI-12/DEC-09: one download link per validated export domain (ventes,
 * paiements, caisse, stock) — a plain `<a>`, not a `fetch` + blob dance:
 * the route already carries the session cookie on a same-origin GET, and
 * `Content-Disposition: attachment` (`lib/http.ts::csvOk`) is what makes
 * the browser save the response instead of trying to render `text/csv`
 * inline. No client state, so no "use client" directive needed.
 */
export function ExportsSection() {
  return (
    <>
      <div className="section-title">
        <div>
          <h2>Exports</h2>
          <p className="eyebrow">Ventes, paiements, caisse et stock, au format CSV</p>
        </div>
      </div>
      <div className="exports-row">
        <a className="outline-button" href="/api/exports/sales">
          Ventes
        </a>
        <a className="outline-button" href="/api/exports/payments">
          Paiements
        </a>
        <a className="outline-button" href="/api/exports/cash">
          Caisse
        </a>
        <a className="outline-button" href="/api/exports/stock">
          Stock
        </a>
      </div>
    </>
  );
}
