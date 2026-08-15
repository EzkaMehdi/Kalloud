"use client";

import { CalendarCheck } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
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

interface ExpectedCash {
  opening_cash: string;
  cash_sales: string;
  cash_in: string;
  cash_out: string;
  expected: string;
}

interface SummaryResponse {
  summary: Summary;
  expectedCash: ExpectedCash;
  cashDiscrepancyThreshold: number;
}

const euro = (value: string | number) => `${Number(value).toFixed(2).replace(".", ",")} €`;
/** Signed, because "+12,00 €" and "−12,00 €" are not the same conversation. */
const signedEuro = (value: number) =>
  `${value > 0 ? "+" : value < 0 ? "−" : ""}${euro(Math.abs(value))}`;

/**
 * CASH-05: closing is a reconciliation, and this dialog follows DEC-04's
 * order literally — opening float, the detail of the calculation, the
 * expected total, *then* the counted amount, then the variance. The count is
 * asked for after the expected figure is on screen because DEC-04 chose a
 * non-blind count for this pilot: the point is to catch an error immediately,
 * not to audit the cashier.
 *
 * CASH-02 remains true here: this closes the service and opens nothing. The
 * "prochain fond" field states what is deliberately left in the drawer, so
 * the next "Ouvrir le service" can propose it — recording an intention, not
 * performing it.
 */
export function CloseDayModal({
  onClose,
  onFinished,
}: {
  onClose: () => void;
  onFinished: () => void;
}) {
  const [data, setData] = useState<SummaryResponse | null>(null);
  const [countedCash, setCountedCash] = useState("");
  const [nextOpeningCash, setNextOpeningCash] = useState("");
  const [varianceReason, setVarianceReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    apiFetch<SummaryResponse>("/api/business-day/summary")
      .then(setData)
      .catch((caught) => {
        setLoadError(
          caught instanceof ApiError
            ? caught.message
            : "Impossible de charger le bilan de la journée.",
        );
      });
  }, []);

  const counted = Number(countedCash);
  const countedIsValid = countedCash.trim() !== "" && Number.isFinite(counted) && counted >= 0;
  // Only meaningful once something has been counted; before that there is no
  // variance to speak of, and showing "−150,00 €" against an empty field
  // would read as an accusation.
  const variance = data && countedIsValid ? counted - Number(data.expectedCash.expected) : null;
  const reasonRequired =
    data !== null && variance !== null && Math.abs(variance) > data.cashDiscrepancyThreshold;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!countedIsValid) {
      setError("Indiquez les espèces comptées (0 € accepté).");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await apiFetch("/api/business-day/close", {
        method: "POST",
        body: JSON.stringify({
          countedCash: counted.toFixed(2),
          ...(nextOpeningCash.trim() === ""
            ? {}
            : { nextOpeningCash: Number(nextOpeningCash).toFixed(2) }),
          ...(varianceReason.trim() === "" ? {} : { varianceReason: varianceReason.trim() }),
        }),
      });
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
      <form onSubmit={submit}>
        <p className="modal-help">
          Le bilan de ce service est figé définitivement : une journée clôturée ne peut pas être
          rouverte. Aucun nouveau service n&apos;est ouvert automatiquement.
        </p>

        {loadError ? (
          <p className="form-error" role="alert">
            {loadError}
          </p>
        ) : !data ? (
          <p className="stock-meta" role="status">
            Chargement du bilan…
          </p>
        ) : (
          <>
            {/* DEC-04, dans l'ordre : fond, détail, attendu. */}
            <div className="closing-summary">
              <div>
                <span>Fond de caisse d&apos;ouverture</span>
                <b>{euro(data.expectedCash.opening_cash)}</b>
              </div>
              <div>
                <span>Ventes espèces</span>
                <b>{euro(data.expectedCash.cash_sales)}</b>
              </div>
              <div>
                <span>Entrées</span>
                <b>{euro(data.expectedCash.cash_in)}</b>
              </div>
              <div>
                <span>Sorties</span>
                <b>−{euro(data.expectedCash.cash_out)}</b>
              </div>
              <div>
                <span>
                  <strong>Espèces attendues</strong>
                </span>
                <b>{euro(data.expectedCash.expected)}</b>
              </div>
            </div>

            <TextField
              label="Espèces comptées (€)"
              type="number"
              step="0.01"
              min="0"
              value={countedCash}
              onChange={(event) => setCountedCash(event.target.value)}
              hint="Comptez le tiroir avant de valider."
              autoFocus
              required
            />

            {variance !== null && (
              <p className={variance === 0 ? "stock-meta" : "form-error"} role="status">
                Écart : <b>{signedEuro(variance)}</b>
                {variance === 0
                  ? " — la caisse tombe juste."
                  : reasonRequired
                    ? ` — au-delà du seuil de ${euro(data.cashDiscrepancyThreshold)}, un motif est obligatoire.`
                    : ` — sous le seuil de ${euro(data.cashDiscrepancyThreshold)}.`}
              </p>
            )}

            {/* `aria-required` rather than `required`: the threshold is a
                server-side setting (CFG-00), and native validation would
                block the submit before the server could answer — leaving the
                user with a browser tooltip instead of the sentence naming
                the actual threshold and variance. The line above already
                warns before the click; the server remains the authority. */}
            <TextField
              label={reasonRequired ? "Motif de l'écart (obligatoire)" : "Motif de l'écart"}
              value={varianceReason}
              onChange={(event) => setVarianceReason(event.target.value)}
              placeholder="Ex. Erreur de rendu de monnaie"
              aria-required={reasonRequired}
            />

            <TextField
              label="Fond laissé pour le prochain service (€)"
              type="number"
              step="0.01"
              min="0"
              value={nextOpeningCash}
              onChange={(event) => setNextOpeningCash(event.target.value)}
              hint="Facultatif. Sera proposé à la prochaine ouverture, sans rien ouvrir."
            />

            <div className="closing-summary">
              <div>
                <span>Chiffre d&apos;affaires du service</span>
                <b>{euro(data.summary.revenue)}</b>
              </div>
              <div>
                <span>Commandes</span>
                <b>{data.summary.orders_count}</b>
              </div>
            </div>
          </>
        )}

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button
          className="primary-button"
          disabled={!data || saving}
          type="submit"
          style={{ width: "100%", marginTop: 20 }}
        >
          <CalendarCheck size={18} aria-hidden="true" />
          {saving ? "Clôture…" : "Compter et clôturer la caisse"}
        </button>
      </form>
    </Dialog>
  );
}
