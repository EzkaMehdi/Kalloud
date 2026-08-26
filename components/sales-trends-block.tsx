"use client";

import { useState } from "react";
import { Dialog } from "@/components/ui/dialog";
import { AsyncSection } from "@/components/ui/async-section";
import { apiFetch } from "@/lib/client/api";
import { useAsyncData } from "@/lib/client/use-async-data";

interface HourlyTrendRow {
  hour: number;
  revenue: string;
  orders_count: number;
}
interface ProductSalesRow {
  product_id: number;
  product_name: string;
  category_name: string | null;
  quantity: number;
  revenue: string;
}
interface CategorySalesRow {
  category_id: number | null;
  category_name: string;
  quantity: number;
  revenue: string;
}
interface TableTurnoverRow {
  table_id: number;
  table_name: string;
  tickets_count: number;
  average_service_minutes: number | null;
}
interface SalesTrends {
  hourly: HourlyTrendRow[];
  byProduct: ProductSalesRow[];
  byCategory: CategorySalesRow[];
  tableTurnover: TableTurnoverRow[];
  averageServiceMinutes: number | null;
}

const eur = (value: string | number) => `${Number(value).toFixed(2).replace(".", ",")} €`;
const TOP_N = 5;

/**
 * BI-11: the block `BI-08` itself deliberately left unbuilt ("le service et
 * ses tests, pas un écran"). `getSalesTrendsForPeriod` (`BI-11`) answers
 * `null` for `period: "service"` with nothing open — rendered as the same
 * empty state as a period with real zero sales, since either way there is
 * nothing yet to break down.
 *
 * The compact block shows the top products by revenue; "Voir tout" opens
 * the full breakdown (every product, every category, the 24 hourly buckets,
 * every table) in a drawer built on the shared `Dialog` (`UX-02`) — a local
 * `useState`, never a navigation, so the dashboard's own period, filters and
 * pagination are still exactly as left when it closes (BI-11's acceptance,
 * "retour au dashboard sans perdre le contexte").
 *
 * `daily` (`SalesTrends`'s own field) is deliberately not rendered here: a
 * calendar day list has no natural bound (up to 365 rows for `année`) unlike
 * every other breakdown, which is bounded by the establishment's own catalog
 * or table count — showing it well is a chart, not a list, and no task has
 * asked for one yet. The data stays available over the API for whenever one
 * does.
 */
export function SalesTrendsBlock({
  period,
  year,
  month,
}: {
  period: "service" | "month" | "year";
  year: number;
  month: number;
}) {
  const [showDetail, setShowDetail] = useState(false);
  const query = useAsyncData(() => {
    const params = new URLSearchParams({ period });
    if (period === "month") {
      params.set("year", String(year));
      params.set("month", String(month));
    } else if (period === "year") {
      params.set("year", String(year));
    }
    return apiFetch<SalesTrends | null>(`/api/sales-trends?${params}`);
  }, [period, year, month]);

  const totalTickets = (data: SalesTrends) =>
    data.tableTurnover.reduce((sum, row) => sum + row.tickets_count, 0);

  const peakHour = (data: SalesTrends) =>
    data.hourly.reduce<HourlyTrendRow | null>(
      (best, row) => (best === null || Number(row.revenue) > Number(best.revenue) ? row : best),
      null,
    );

  return (
    <>
      <div className="section-title">
        <div>
          <h2>Tendances de vente</h2>
          <p className="eyebrow">Produits, catégories et rotation des tables</p>
        </div>
      </div>
      <AsyncSection
        state={query.state}
        onRetry={query.refetch}
        isEmpty={(data) => data === null || data.byProduct.length === 0}
        emptyMessage="Aucune vente sur la période sélectionnée."
      >
        {(data) => {
          if (data === null) return null; // isEmpty already filtered this out.
          const peak = peakHour(data);
          return (
            <div className="history-card">
              {data.byProduct.slice(0, TOP_N).map((row) => (
                <div className="order-row" key={row.product_id}>
                  <div>
                    <b>{row.product_name}</b>
                    <small>
                      {row.category_name ?? "Sans catégorie"} · {row.quantity} vendu
                      {row.quantity > 1 ? "s" : ""}
                    </small>
                  </div>
                  <strong>{eur(row.revenue)}</strong>
                </div>
              ))}
              <div className="order-row">
                <div>
                  <b>Rotation des tables</b>
                  <small>
                    {totalTickets(data)} ticket{totalTickets(data) > 1 ? "s" : ""} à table
                    {data.averageServiceMinutes !== null &&
                      ` · ${Math.round(data.averageServiceMinutes)} min en moyenne`}
                  </small>
                </div>
                {peak && (
                  <strong>
                    Pic {peak.hour}h ({eur(peak.revenue)})
                  </strong>
                )}
              </div>
              <button type="button" className="outline-button" onClick={() => setShowDetail(true)}>
                Voir tout
              </button>
            </div>
          );
        }}
      </AsyncSection>

      {showDetail && query.state.status === "success" && query.state.data !== null && (
        <Dialog title="Détail des ventes" eyebrow="Tendances" onClose={() => setShowDetail(false)}>
          <TrendsDetail data={query.state.data} />
        </Dialog>
      )}
    </>
  );
}

function TrendsDetail({ data }: { data: SalesTrends }) {
  return (
    <>
      <h3>Ventes par produit</h3>
      <div className="history-card">
        {data.byProduct.map((row) => (
          <div className="order-row" key={row.product_id}>
            <div>
              <b>{row.product_name}</b>
              <small>{row.category_name ?? "Sans catégorie"}</small>
            </div>
            <strong>
              {row.quantity} · {eur(row.revenue)}
            </strong>
          </div>
        ))}
      </div>

      <h3>Ventes par catégorie</h3>
      <div className="history-card">
        {data.byCategory.map((row) => (
          <div className="order-row" key={row.category_id ?? "none"}>
            <div>
              <b>{row.category_name}</b>
            </div>
            <strong>
              {row.quantity} · {eur(row.revenue)}
            </strong>
          </div>
        ))}
      </div>

      <h3>Évolution horaire</h3>
      <div className="history-card">
        {data.hourly.map((row) => (
          <div className="order-row" key={row.hour}>
            <div>
              <b>{row.hour}h</b>
              <small>
                {row.orders_count} commande{row.orders_count > 1 ? "s" : ""}
              </small>
            </div>
            <strong>{eur(row.revenue)}</strong>
          </div>
        ))}
      </div>

      <h3>Rotation des tables</h3>
      <div className="history-card">
        {data.tableTurnover.map((row) => (
          <div className="order-row" key={row.table_id}>
            <div>
              <b>{row.table_name}</b>
              <small>
                {row.tickets_count} ticket{row.tickets_count > 1 ? "s" : ""}
              </small>
            </div>
            <strong>
              {row.average_service_minutes !== null
                ? `${Math.round(row.average_service_minutes)} min`
                : "—"}
            </strong>
          </div>
        ))}
      </div>
    </>
  );
}
