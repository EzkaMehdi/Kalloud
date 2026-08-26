"use client";

import { AsyncSection } from "@/components/ui/async-section";
import { apiFetch } from "@/lib/client/api";
import { useAsyncData } from "@/lib/client/use-async-data";

interface ComparisonFigure<T> {
  current: T;
  previous: T | null;
  changePercent: number | null;
}

interface PerformanceComparison {
  netRevenue: ComparisonFigure<string>;
  ordersCount: ComparisonFigure<number>;
  averageBasket: ComparisonFigure<string>;
  comparisonLabel: string;
}

const eur = (value: string | number) => `${Number(value).toFixed(2).replace(".", ",")} €`;

function Delta({ changePercent }: { changePercent: number | null }) {
  if (changePercent === null) {
    return <b className="delta">—</b>;
  }
  const rounded = Math.round(changePercent * 10) / 10;
  const sign = rounded > 0 ? "+" : "";
  return (
    <b className={`delta ${rounded > 0 ? "up" : rounded < 0 ? "down" : ""}`}>
      {sign}
      {rounded.toFixed(1).replace(".", ",")} %
    </b>
  );
}

/**
 * BI-11: the block `BI-07` itself deliberately left unbuilt ("le service et
 * ses tests, pas un écran"). No "Voir tout" here — three compared figures
 * *are* the whole detail; there is nothing further beneath them to drill
 * into, unlike `SalesTrendsBlock`'s breakdowns.
 */
export function PerformanceComparisonBlock({
  period,
  year,
  month,
}: {
  period: "service" | "month" | "year";
  year: number;
  month: number;
}) {
  const query = useAsyncData(() => {
    const params = new URLSearchParams({ period });
    if (period === "month") {
      params.set("year", String(year));
      params.set("month", String(month));
    } else if (period === "year") {
      params.set("year", String(year));
    }
    return apiFetch<PerformanceComparison>(`/api/performance-comparison?${params}`);
  }, [period, year, month]);

  return (
    <>
      <div className="section-title">
        <div>
          <h2>Comparaison de performance</h2>
          <p className="eyebrow">CA, commandes et panier moyen face à une période comparable</p>
        </div>
      </div>
      <AsyncSection state={query.state} onRetry={query.refetch}>
        {(comparison) => (
          <div className="kpis">
            {/* BI-11: "CA net" / "Ventes" / "Ticket moyen" — deliberately not
                the KPI cards' own "Chiffre d'affaires" / "Commandes" /
                "Panier moyen" labels just above. Those e2e specs locate a
                card by `.kpi` filtered on that exact text
                (`bilan-real-data.spec.ts`); reusing the same wording here
                would make every one of those locators match two cards. */}
            <div className="kpi">
              <span className="kpi-label">CA net</span>
              <strong>{eur(comparison.netRevenue.current)}</strong>
              <div className="split">
                <Delta changePercent={comparison.netRevenue.changePercent} />
                <span>{comparison.comparisonLabel}</span>
              </div>
            </div>
            <div className="kpi">
              <span className="kpi-label">Ventes</span>
              <strong>{comparison.ordersCount.current}</strong>
              <div className="split">
                <Delta changePercent={comparison.ordersCount.changePercent} />
                <span>{comparison.comparisonLabel}</span>
              </div>
            </div>
            <div className="kpi">
              <span className="kpi-label">Ticket moyen</span>
              <strong>{eur(comparison.averageBasket.current)}</strong>
              <div className="split">
                <Delta changePercent={comparison.averageBasket.changePercent} />
                <span>{comparison.comparisonLabel}</span>
              </div>
            </div>
          </div>
        )}
      </AsyncSection>
    </>
  );
}
