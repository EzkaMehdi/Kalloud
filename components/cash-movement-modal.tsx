"use client";

import { ArrowDownToLine, ArrowUpFromLine } from "lucide-react";
import { FormEvent, useState } from "react";
import { Dialog } from "@/components/ui/dialog";
import { TextField } from "@/components/ui/text-field";
import { ApiError, apiFetch } from "@/lib/client/api";
import {
  CASH_MOVEMENT_CATEGORIES_BY_TYPE,
  CASH_MOVEMENT_CATEGORY_LABELS,
  type CashMovementCategory,
} from "@/lib/validation/primitives";

export function CashMovementModal({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: (amount: number, type: "IN" | "OUT") => void;
}) {
  const [type, setType] = useState<"IN" | "OUT">("IN");
  // CASH-03/DEC-11: "OTHER" is the default on purpose. It is the one category
  // valid for both directions, and it is the honest answer until the user
  // states otherwise — defaulting to the first of the list would silently
  // file movements as "Retrait de fin de service", the very category CASH-04
  // must be able to trust.
  const [category, setCategory] = useState<CashMovementCategory>("OTHER");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // API-02: same rule as the checkout drawer — one key per intended
  // movement, reused on every retry so a lost response cannot become two
  // withdrawals in the cash journal.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());

  /**
   * Switching direction can invalidate the chosen category (DEC-11 pairs the
   * two), so it falls back to the one value both directions accept rather
   * than being left pointing at a category the server would reject.
   */
  function changeType(next: "IN" | "OUT") {
    setType(next);
    if (!(CASH_MOVEMENT_CATEGORIES_BY_TYPE[next] as readonly string[]).includes(category)) {
      setCategory("OTHER");
    }
  }

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
        body: JSON.stringify({ type, category, amount: value.toFixed(2), reason: reason.trim() }),
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
            onClick={() => changeType("IN")}
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
            onClick={() => changeType("OUT")}
            className={type === "OUT" ? "selected out" : ""}
          >
            <ArrowUpFromLine size={19} aria-hidden="true" />
            <span>Sortie</span>
            <small>Dépense ou retrait</small>
          </button>
        </div>
        {/* CASH-03/DEC-11: the nature of the movement, next to its direction.
            Two 200 € withdrawals used to be indistinguishable — consumables
            bought for the kitchen and the end-of-service emptying of the
            drawer — and CASH-04 has to tell them apart. */}
        <label className="field-label">
          Catégorie
          <select
            className="input"
            value={category}
            onChange={(event) => setCategory(event.target.value as CashMovementCategory)}
          >
            {CASH_MOVEMENT_CATEGORIES_BY_TYPE[type].map((value) => (
              <option key={value} value={value}>
                {CASH_MOVEMENT_CATEGORY_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
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
          {/* "Valider l'sortie" — the elision only works for "entrée". */}
          {saving ? "Enregistrement…" : type === "IN" ? "Valider l'entrée" : "Valider la sortie"}
        </button>
      </form>
    </Dialog>
  );
}
