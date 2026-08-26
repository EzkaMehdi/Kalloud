"use client";

import { AsyncSection } from "@/components/ui/async-section";
import { apiFetch } from "@/lib/client/api";
import { useAsyncData } from "@/lib/client/use-async-data";

interface CashReconciliation {
  status: "open" | "closed" | "never_opened";
  openingCash: string;
  cashSales: string;
  cashIn: string;
  cashOut: string;
  expected: string;
  counted: string | null;
  variance: string | null;
  varianceReason: string | null;
  closedAt: string | null;
}

const eur = (value: string | number) => `${Number(value).toFixed(2).replace(".", ",")} €`;
/** Signed, because "+12,00 €" and "−12,00 €" are not the same conversation — mirrors `close-day-modal.tsx`'s own helper. */
const signedEuro = (value: number) =>
  `${value > 0 ? "+" : value < 0 ? "−" : ""}${eur(Math.abs(value))}`;

const dateFormatter = new Intl.DateTimeFormat("fr-FR", {
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

/**
 * BI-11: the block `BI-09` itself deliberately left unbuilt ("le service et
 * ses tests, pas un écran"). Built on `getCashReconciliation` (`BI-09`)
 * exactly as-is — no second read of `expected`/`counted`/`variance`, so this
 * block cannot show a figure that disagrees with the closing modal
 * (`CASH-05`) it mirrors. `"closed"`'s écart card reads the *frozen*
 * columns, per that service's own note — this component never recomputes
 * anything, only renders what it was handed.
 */
export function CashReconciliationBlock() {
  const query = useAsyncData(() => apiFetch<CashReconciliation>("/api/cash-reconciliation"), []);

  return (
    <>
      <div className="section-title">
        <div>
          <h2>Rapprochement de caisse</h2>
          <p className="eyebrow">Fond, ventes espèces, entrées, sorties et écart</p>
        </div>
      </div>
      <AsyncSection state={query.state} onRetry={query.refetch}>
        {(data) => (
          <div className="kpis">
            {/* BI-11: "Solde de caisse attendu" — deliberately not the KPI
                cards' own conditional "Espèces attendues" label just above
                (rendered only while a service is open, CASH-04).
                `bilan-real-data.spec.ts` asserts that exact label is absent
                for a brand-new establishment (`.kpi[hasText=…]).toHaveCount(0)`);
                this block renders unconditionally (`never_opened` included),
                so sharing that label would make the assertion see one. */}
            <div className="kpi">
              <span className="kpi-label">
                {data.status === "closed"
                  ? "Solde de caisse attendu (dernière clôture)"
                  : "Solde de caisse attendu"}
              </span>
              <strong>{eur(data.expected)}</strong>
              <div className="split">
                <span>
                  Fond <b>{eur(data.openingCash)}</b>
                </span>
                <span>
                  Ventes <b>{eur(data.cashSales)}</b>
                </span>
                <span>
                  Entrées <b>{eur(data.cashIn)}</b>
                </span>
                <span>
                  Sorties <b>{eur(data.cashOut)}</b>
                </span>
              </div>
            </div>
            {data.status === "open" && (
              <div className="kpi">
                <span className="kpi-label">Écart</span>
                <strong>—</strong>
                <div className="split">
                  <span>Compté à la clôture du service en cours.</span>
                </div>
              </div>
            )}
            {data.status === "never_opened" && (
              <div className="kpi">
                <span className="kpi-label">Écart</span>
                <strong>—</strong>
                <div className="split">
                  <span>Aucun service n&apos;a encore été ouvert.</span>
                </div>
              </div>
            )}
            {data.status === "closed" && data.variance !== null && (
              <div className="kpi">
                <span className="kpi-label">Écart à la clôture</span>
                <strong
                  className={`delta ${Number(data.variance) > 0 ? "up" : Number(data.variance) < 0 ? "down" : ""}`}
                >
                  {signedEuro(Number(data.variance))}
                </strong>
                <div className="split">
                  <span>
                    Compté <b>{eur(data.counted ?? "0.00")}</b>
                  </span>
                  {data.closedAt && (
                    <span>
                      Clôturé le <b>{dateFormatter.format(new Date(data.closedAt))}</b>
                    </span>
                  )}
                  {data.varianceReason && (
                    <span>
                      Motif <b>{data.varianceReason}</b>
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </AsyncSection>
    </>
  );
}
