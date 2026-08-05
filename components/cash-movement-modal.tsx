"use client";

import { ArrowDownToLine, ArrowUpFromLine } from "lucide-react";
import { FormEvent, useState } from "react";
import { Dialog } from "@/components/ui/dialog";
import { TextField } from "@/components/ui/text-field";
import { ApiError, apiFetch } from "@/lib/client/api";

export function CashMovementModal({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: (amount: number, type: "IN" | "OUT") => void;
}) {
  const [type, setType] = useState<"IN" | "OUT">("IN");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // API-02: same rule as the checkout drawer — one key per intended
  // movement, reused on every retry so a lost response cannot become two
  // withdrawals in the cash journal.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());

  async function submit(event: FormEvent) {
    event.preventDefault();
    const value = Number(amount);
    if (!value || value <= 0 || !reason.trim()) {
      setError("Indiquez un montant et un motif.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await apiFetch("/api/cash-movements", {
        method: "POST",
        idempotencyKey,
        body: JSON.stringify({ type, amount: value.toFixed(2), reason: reason.trim() }),
      });
      setIdempotencyKey(crypto.randomUUID());
      onSaved(value, type);
      onClose();
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : "Impossible d'enregistrer le mouvement.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog title="Nouveau mouvement" eyebrow="Journal de caisse" onClose={onClose}>
      <form onSubmit={submit}>
        <p className="modal-help">
          Enregistrez chaque entrée ou sortie d&apos;espèces qui n&apos;est pas une vente.
        </p>
        <div className="movement-types" role="radiogroup" aria-label="Type de mouvement">
          <button
            type="button"
            role="radio"
            aria-checked={type === "IN"}
            onClick={() => setType("IN")}
            className={type === "IN" ? "selected in" : ""}
          >
            <ArrowDownToLine size={19} aria-hidden="true" />
            <span>Entrée</span>
            <small>Ajout d&apos;espèces</small>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={type === "OUT"}
            onClick={() => setType("OUT")}
            className={type === "OUT" ? "selected out" : ""}
          >
            <ArrowUpFromLine size={19} aria-hidden="true" />
            <span>Sortie</span>
            <small>Dépense ou retrait</small>
          </button>
        </div>
        <TextField
          label="Montant (€)"
          inputMode="decimal"
          type="number"
          min="0.01"
          step="0.01"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          placeholder="Ex. 20,00"
          autoFocus
          required
        />
        <TextField
          label="Motif"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder={type === "IN" ? "Ex. Ajout de monnaie" : "Ex. Achat urgent"}
          required
        />
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button
          className="primary-button"
          style={{ width: "100%", marginTop: 20 }}
          disabled={saving}
        >
          {saving ? "Enregistrement…" : `Valider l'${type === "IN" ? "entrée" : "sortie"}`}
        </button>
      </form>
    </Dialog>
  );
}
