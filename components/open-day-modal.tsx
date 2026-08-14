"use client";

import { CalendarPlus } from "lucide-react";
import { FormEvent, useState } from "react";
import { Dialog } from "@/components/ui/dialog";
import { TextField } from "@/components/ui/text-field";
import { ApiError, apiFetch } from "@/lib/client/api";

/**
 * CASH-02: the "Ouvrir le service" half of the split DEC-04 mandates. This
 * is the only way a business day is created from the interface — closing no
 * longer opens anything — so the opening fund is stated here, by whoever
 * opens the service, instead of being typed into the closing dialog for a
 * service that had not started yet.
 *
 * A fund of 0 € is legitimate (a till that starts empty), so the field is
 * only rejected when it is blank or not a valid amount, never for being
 * zero. The server is the authority either way (`openBusinessDaySchema`).
 */
export function OpenDayModal({
  onClose,
  onOpened,
}: {
  onClose: () => void;
  onOpened: (openingCash: number) => void;
}) {
  const [openingCash, setOpeningCash] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    const value = Number(openingCash);
    if (openingCash.trim() === "" || Number.isNaN(value) || value < 0) {
      setError("Indiquez le fond de caisse d'ouverture (0 € accepté).");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await apiFetch("/api/business-day", {
        method: "POST",
        body: JSON.stringify({ openingCash: value.toFixed(2) }),
      });
      onOpened(value);
      onClose();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Impossible d'ouvrir le service.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog title="Ouvrir le service" eyebrow="Nouvelle journée de caisse" onClose={onClose}>
      <form onSubmit={submit}>
        <p className="modal-help">
          Comptez les espèces présentes dans le tiroir avant de commencer. Ce montant sert de point
          de départ au calcul de la caisse attendue à la clôture.
        </p>
        <TextField
          label="Fond de caisse d'ouverture (€)"
          type="number"
          step="0.01"
          min="0"
          value={openingCash}
          onChange={(event) => setOpeningCash(event.target.value)}
        />
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button
          className="primary-button"
          disabled={saving}
          type="submit"
          style={{ width: "100%", marginTop: 20 }}
        >
          <CalendarPlus size={18} aria-hidden="true" />
          {saving ? "Ouverture…" : "Ouvrir le service"}
        </button>
      </form>
    </Dialog>
  );
}
