"use client";

import { CalendarCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { Dialog } from "@/components/ui/dialog";
import { TextField } from "@/components/ui/text-field";
import { ApiError, apiFetch } from "@/lib/client/api";

interface Summary {
  revenue: string;
  cash_revenue: string;
  card_revenue: string;
  orders_count: number;
  average_basket: string;
}

interface SummaryResponse {
  day: { opening_cash: string };
  summary: Summary;
}

interface CloseResponse {
  opened: { opening_cash: string };
}

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
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    apiFetch<SummaryResponse>("/api/business-day/summary")
      .then((data) => {
        setSummary(data.summary);
        setOpening(String(data.day.opening_cash));
      })
      .catch((caught) => {
        setLoadError(
          caught instanceof ApiError
            ? caught.message
            : "Impossible de charger le bilan de la journée.",
        );
      });
  }, []);

  const euro = (value: string | number) => `${Number(value).toFixed(2).replace(".", ",")} €`;

  async function confirm() {
    setSaving(true);
    setError("");
    try {
      const data = await apiFetch<CloseResponse>("/api/business-day/close", {
        method: "POST",
        body: JSON.stringify({ nextOpeningCash: Number(opening) }),
      });
      onFinished(Number(data.opened.opening_cash));
      onClose();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Erreur de clôture.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      title="Clôturer et ouvrir un nouveau service"
      eyebrow="Clôture manuelle"
      onClose={onClose}
    >
      <p className="modal-help">
        Le bilan du service actuel est figé, puis un nouveau service démarre immédiatement avec le
        fond de caisse indiqué ci-dessous. Idéal quand le service se termine après minuit.
      </p>
      {loadError ? (
        <p className="form-error" role="alert">
          {loadError}
        </p>
      ) : summary ? (
        <div className="closing-summary">
          <div>
            <span>Chiffre d&apos;affaires</span>
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
        <p className="stock-meta" role="status">
          Chargement du bilan…
        </p>
      )}
      <TextField
        label="Fond de caisse du nouveau service (€)"
        type="number"
        step="0.01"
        min="0"
        value={opening}
        onChange={(event) => setOpening(event.target.value)}
      />
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <button
        className="primary-button"
        disabled={!summary || saving}
        onClick={confirm}
        style={{ width: "100%", marginTop: 20 }}
      >
        <CalendarCheck size={18} aria-hidden="true" />
        {saving ? "Clôture…" : "Clôturer et ouvrir le nouveau service"}
      </button>
    </Dialog>
  );
}
