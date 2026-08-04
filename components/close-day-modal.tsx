"use client";
import { CalendarCheck, X } from "lucide-react";
import { useEffect, useState } from "react";

type Summary = {
  revenue: string;
  cash_revenue: string;
  card_revenue: string;
  orders_count: number;
  average_basket: string;
};
export function CloseDayModal({
  onClose,
  onFinished,
}: {
  onClose: () => void;
  onFinished: (opening: number) => void;
}) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [opening, setOpening] = useState("150");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    fetch("http://localhost:3001/api/business-day/summary")
      .then((r) => r.json())
      .then((d) => {
        setSummary(d.summary);
        setOpening(String(d.day.opening_cash));
      })
      .catch(() => setError("Impossible de charger le bilan de la journée."));
  }, []);
  const euro = (value: string | number) => `${Number(value).toFixed(2).replace(".", ",")} €`;
  async function confirm() {
    setSaving(true);
    try {
      const response = await fetch("http://localhost:3001/api/business-day/close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nextOpeningCash: Number(opening) }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      onFinished(Number(data.opened.opening_cash));
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erreur de clôture");
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="modal-backdrop">
      <div className="drawer close-day">
        <div className="drawer-handle" />
        <div className="drawer-title">
          <div>
            <span className="eyebrow">Clôture manuelle</span>
            <h2>Terminer la journée</h2>
          </div>
          <button className="icon-button" onClick={onClose}>
            <X size={19} />
          </button>
        </div>
        <p className="modal-help">
          Le bilan est figé, puis une nouvelle journée de caisse est ouverte. C’est idéal quand le
          service termine après minuit.
        </p>
        {summary ? (
          <div className="closing-summary">
            <div>
              <span>Chiffre d’affaires</span>
              <b>{euro(summary.revenue)}</b>
            </div>
            <div>
              <span>Espèces encaissées</span>
              <b>{euro(summary.cash_revenue)}</b>
            </div>
            <div>
              <span>CB encaissée</span>
              <b>{euro(summary.card_revenue)}</b>
            </div>
            <div>
              <span>Commandes</span>
              <b>{summary.orders_count}</b>
            </div>
          </div>
        ) : (
          <p className="stock-meta">Chargement du bilan…</p>
        )}
        <label className="field-label">
          Fond de caisse de la nouvelle journée (€)
          <input
            className="input"
            type="number"
            step="0.01"
            min="0"
            value={opening}
            onChange={(e) => setOpening(e.target.value)}
          />
        </label>
        {error && <p className="form-error">{error}</p>}
        <button
          className="primary-button"
          disabled={!summary || saving}
          onClick={confirm}
          style={{ width: "100%", marginTop: 20 }}
        >
          <CalendarCheck size={18} />
          {saving ? "Clôture…" : "Clôturer et ouvrir la nouvelle journée"}
        </button>
      </div>
    </div>
  );
}
