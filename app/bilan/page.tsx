"use client";

import { useMemo, useState } from "react";
import { AsyncSection } from "@/components/ui/async-section";
import { Shell } from "@/components/shell";
import { apiFetch } from "@/lib/client/api";
import { useAsyncData } from "@/lib/client/use-async-data";

interface DashboardStats {
  revenue: string;
  cash_revenue: string;
  card_revenue: string;
  orders_count: number;
  average_basket: string;
}

interface OrderRow {
  id: number;
  table_name: string | null;
  status: string;
  payment_method: string | null;
  total_amount: string;
  created_at: string;
  closed_at: string | null;
}

interface CashMovementRow {
  id: number;
  type: "OPENING" | "IN" | "OUT";
  amount: string;
  reason: string;
  created_at: string;
}

const months = [
  "Janvier",
  "Février",
  "Mars",
  "Avril",
  "Mai",
  "Juin",
  "Juillet",
  "Août",
  "Septembre",
  "Octobre",
  "Novembre",
  "Décembre",
];

const PAYMENT_LABELS: Record<string, string> = { CASH: "Espèces", CARD: "CB", MIXED: "Mixte" };

export default function Bilan() {
  const now = useMemo(() => new Date(), []);
  const years = useMemo(() => [now.getFullYear(), now.getFullYear() - 1], [now]);

  const [period, setPeriod] = useState<"Aujourd’hui" | "Ce mois" | "Cette année">("Aujourd’hui");
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());

  const periodKey = period === "Aujourd’hui" ? "day" : period === "Ce mois" ? "month" : "year";
  const statsQuery = useAsyncData(
    () =>
      apiFetch<DashboardStats>(`/api/dashboard?period=${periodKey}&month=${month}&year=${year}`),
    [periodKey, month, year],
  );
  const ordersQuery = useAsyncData(() => apiFetch<OrderRow[]>("/api/orders"), []);
  const movementsQuery = useAsyncData(() => apiFetch<CashMovementRow[]>("/api/cash-movements"), []);

  const eur = (value: string | number) => `${Number(value).toFixed(2).replace(".", ",")} €`;
  const dateFormatter = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" });

  return (
    <Shell>
      <div className="page-head">
        <div>
          <p className="eyebrow">Suivi de l&apos;activité</p>
          <h1>Le bilan</h1>
        </div>
      </div>

      <div className="segmented" role="tablist" aria-label="Période">
        {(["Aujourd’hui", "Ce mois", "Cette année"] as const).map((option) => (
          <button
            onClick={() => setPeriod(option)}
            key={option}
            role="tab"
            aria-selected={period === option}
            className={`segment ${period === option ? "active" : ""}`}
          >
            {option}
          </button>
        ))}
      </div>

      <div className="period-selects">
        <label>
          Mois
          <select
            value={month}
            onChange={(event) => {
              setMonth(Number(event.target.value));
              setPeriod("Ce mois");
            }}
            disabled={period !== "Ce mois"}
          >
            {months.map((label, index) => (
              <option value={index + 1} key={label}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Année
          <select
            value={year}
            onChange={(event) => setYear(Number(event.target.value))}
            disabled={period === "Aujourd’hui"}
          >
            {years.map((y) => (
              <option value={y} key={y}>
                {y}
              </option>
            ))}
          </select>
        </label>
      </div>

      <AsyncSection state={statsQuery.state} onRetry={statsQuery.refetch}>
        {(stats) => (
          <div className="kpis">
            <div className="kpi">
              <span className="kpi-label">Chiffre d&apos;affaires</span>
              <strong>{eur(stats.revenue)}</strong>
              <div className="split">Ventes encaissées</div>
            </div>
            <div className="kpi">
              <span className="kpi-label">Ventilation caisse</span>
              <strong>
                {eur(stats.cash_revenue)} / {eur(stats.card_revenue)}
              </strong>
              <div className="split">
                <span>
                  Espèces <b>{eur(stats.cash_revenue)}</b>
                </span>
                <span>
                  CB <b>{eur(stats.card_revenue)}</b>
                </span>
              </div>
            </div>
            <div className="kpi">
              <span className="kpi-label">Commandes</span>
              <strong>{stats.orders_count}</strong>
              <div className="split">Pour la période</div>
            </div>
            <div className="kpi">
              <span className="kpi-label">Panier moyen</span>
              <strong>{eur(stats.average_basket)}</strong>
              <div className="split">par commande</div>
            </div>
          </div>
        )}
      </AsyncSection>

      <div className="section-title">
        <div>
          <h2>Commandes récentes</h2>
          <p className="eyebrow">Dernières ventes de l&apos;établissement</p>
        </div>
      </div>
      <AsyncSection
        state={ordersQuery.state}
        onRetry={ordersQuery.refetch}
        isEmpty={(data) => data.length === 0}
        emptyMessage="Aucune commande encaissée pour le moment."
      >
        {(orders) => (
          <div className="history-card">
            {orders.slice(0, 8).map((order) => (
              <div className="order-row" key={order.id}>
                <div>
                  <b>{order.table_name ?? "Vente directe"}</b>
                  <small>
                    {dateFormatter.format(new Date(order.closed_at ?? order.created_at))} ·{" "}
                    {order.payment_method ? PAYMENT_LABELS[order.payment_method] : "—"}
                  </small>
                </div>
                <strong>{eur(order.total_amount)}</strong>
              </div>
            ))}
          </div>
        )}
      </AsyncSection>

      <div className="section-title">
        <div>
          <h2>Journal de caisse</h2>
          <p className="eyebrow">Mouvements les plus récents</p>
        </div>
      </div>
      <AsyncSection
        state={movementsQuery.state}
        onRetry={movementsQuery.refetch}
        isEmpty={(data) => data.length === 0}
        emptyMessage="Aucun mouvement de caisse enregistré."
      >
        {(movements) => (
          <div className="history-card">
            {movements.slice(0, 8).map((movement) => (
              <div className="movement" key={movement.id}>
                <div>
                  <b>{movement.reason}</b>
                  <small>
                    {dateFormatter.format(new Date(movement.created_at))} ·{" "}
                    {movement.type === "OPENING"
                      ? "Ouverture"
                      : movement.type === "IN"
                        ? "Entrée"
                        : "Sortie"}
                  </small>
                </div>
                <b className={movement.type === "OUT" ? "out" : "in"}>
                  {movement.type === "OUT" ? "−" : "+"}
                  {eur(movement.amount)}
                </b>
              </div>
            ))}
          </div>
        )}
      </AsyncSection>
    </Shell>
  );
}
