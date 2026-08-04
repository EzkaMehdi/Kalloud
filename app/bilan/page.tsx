"use client";
import { ArrowDownLeft, ArrowUpRight } from "lucide-react";
import { useEffect, useState } from "react";
import { Shell } from "../../components/shell";
const orders = [
  { table: "Table 4", time: "18:24", items: "2 articles · CB", amount: "33,00 €" },
  { table: "Comptoir", time: "17:51", items: "1 article · Espèces", amount: "8,00 €" },
  { table: "Table 2", time: "17:16", items: "4 articles · Mixte", amount: "56,00 €" },
  { table: "Table 1", time: "16:03", items: "2 articles · CB", amount: "29,00 €" },
];
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
export default function Bilan() {
  const [period, setPeriod] = useState("Aujourd’hui");
  const [month, setMonth] = useState(8);
  const [year, setYear] = useState(2026);
  const [stats, setStats] = useState({
    revenue: 0,
    cash_revenue: 0,
    card_revenue: 0,
    orders_count: 0,
    average_basket: 0,
  });
  useEffect(() => {
    const key = period === "Aujourd’hui" ? "day" : period === "Ce mois" ? "month" : "year";
    fetch(`http://localhost:3001/api/dashboard?period=${key}&month=${month}&year=${year}`)
      .then((r) => r.json())
      .then((d) =>
        setStats(
          Object.fromEntries(Object.entries(d).map(([k, v]) => [k, Number(v)])) as typeof stats,
        ),
      )
      .catch(() => {});
  }, [period, month, year]);
  const eur = (n: number) => `${n.toFixed(2).replace(".", ",")} €`;
  return (
    <Shell>
      <div className="page-head">
        <div>
          <p className="eyebrow">Suivi de l’activité</p>
          <h1>Le bilan</h1>
        </div>
      </div>
      <div className="segmented">
        {["Aujourd’hui", "Ce mois", "Cette année"].map((x) => (
          <button
            onClick={() => setPeriod(x)}
            key={x}
            className={`segment ${period === x ? "active" : ""}`}
          >
            {x}
          </button>
        ))}
      </div>
      <div className="period-selects">
        <label>
          Mois
          <select
            value={month}
            onChange={(e) => {
              setMonth(Number(e.target.value));
              setPeriod("Ce mois");
            }}
          >
            {months.map((m, i) => (
              <option value={i + 1} key={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label>
          Année
          <select value={year} onChange={(e) => setYear(Number(e.target.value))}>
            <option value={2026}>2026</option>
            <option value={2025}>2025</option>
          </select>
        </label>
      </div>
      <div className="kpis">
        <div className="kpi">
          <span className="kpi-label">Chiffre d’affaires</span>
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
      <div className="section-title">
        <div>
          <h2>Commandes terminées</h2>
          <p className="eyebrow">Les dernières ventes</p>
        </div>
        <button className="outline-button">Voir tout</button>
      </div>
      <div className="history-card">
        {orders.map((o) => (
          <div className="order-row" key={o.time}>
            <div>
              <b>{o.table}</b>
              <small>
                {o.time} · {o.items}
              </small>
            </div>
            <strong>{o.amount}</strong>
          </div>
        ))}
      </div>
      <div className="section-title">
        <div>
          <h2>Journal de caisse</h2>
          <p className="eyebrow">Mouvements du jour</p>
        </div>
      </div>
      <div className="history-card">
        <div className="movement">
          <div>
            <b>Fond de caisse</b>
            <small>09:00 · Ouverture</small>
          </div>
          <b className="in">+150,00 €</b>
        </div>
        <div className="movement">
          <div>
            <b>Achats urgence</b>
            <small>14:30 · Sortie espèces</small>
          </div>
          <b className="out">−20,00 €</b>
        </div>
      </div>
    </Shell>
  );
}
