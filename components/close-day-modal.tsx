"use client";

import { CalendarCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { Dialog } from "@/components/ui/dialog";
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

/**
 * CASH-02: closes the service and stops there. This dialog used to carry a
 * "fond de caisse du nouveau service" field and close-then-reopen in one
 * confirmation, which is precisely what DEC-04 rules out — the next service
 * is now opened by its own action, from the caisse screen, when someone
 * decides to open it.
 *
 * The wording is the one CASH-02 mandates ("Compter et clôturer la caisse").
 * The counted-cash input and the variance it produces are CASH-05; until
 * then this screen shows the service's figures and closes on the calculated
 * amount, and deliberately does not pretend to collect a count it has
 * nowhere to store.
 */
export function CloseDayModal({
  onClose,
  onFinished,
}: {
  onClose: () => void;
  onFinished: () => void;
}) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [openingCash, setOpeningCash] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    apiFetch<SummaryResponse>("/api/business-day/summary")
      .then((data) => {
        setSummary(data.summary);
        setOpeningCash(data.day.opening_cash);
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
      await apiFetch("/api/business-day/close", { method: "POST" });
      onFinished();
      onClose();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Erreur de clôture.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog title="Compter et clôturer la caisse" eyebrow="Clôture du service" onClose={onClose}>
      <p className="modal-help">
        Le bilan de ce service est figé définitivement : une journée clôturée ne peut pas être
        rouverte. Aucun nouveau service n&apos;est ouvert automatiquement — vous pourrez en ouvrir
        un ensuite, si vous le souhaitez.
      </p>
      {loadError ? (
        <p className="form-error" role="alert">
          {loadError}
        </p>
      ) : summary ? (
        <div className="closing-summary">
          <div>
            <span>Fond de caisse d&apos;ouverture</span>
            <b>{euro(openingCash ?? 0)}</b>
          </div>
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
        {saving ? "Clôture…" : "Compter et clôturer la caisse"}
      </button>
    </Dialog>
  );
}
