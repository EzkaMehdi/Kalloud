"use client";

import { PackagePlus } from "lucide-react";
import { FormEvent, useState } from "react";
import { Dialog } from "@/components/ui/dialog";
import { TextField } from "@/components/ui/text-field";
import { ApiError, apiFetch } from "@/lib/client/api";
import {
  MANUAL_STOCK_MOVEMENT_TYPES,
  STOCK_MOVEMENT_DIRECTION,
  STOCK_MOVEMENT_TYPE_LABELS,
  type ManualStockMovementType,
} from "@/lib/validation/primitives";

export interface AdjustableProduct {
  id: number;
  name: string;
  stock_quantity: number;
}

/**
 * STK-05: the contextual dialog that replaces `window.prompt()`.
 *
 * The prompt asked one question — "combien ?" — and answered the other two
 * on the user's behalf: every adjustment was filed as a `RECEIPT` with the
 * fixed motive "Réception de marchandise", so a breakage and a delivery were
 * indistinguishable in a ledger DEC-06 designed to tell them apart. It was
 * also the kind of dialog a browser may simply decline to show (Chrome's
 * "prevent this page from creating additional dialogs" silences every later
 * call), which turned a click into nothing at all, with no error to read.
 *
 * The quantity is entered as a plain positive number and the *direction*
 * comes from the movement type (DEC-06 / migrations/0007): a receipt adds, a
 * loss removes. Asking a user to type "-3" would be asking them to encode a
 * rule the type already states. `CORRECTION` is the exception — it is the
 * one type that may go either way — so it, and only it, asks which way.
 */
export function StockAdjustModal({
  product,
  products,
  onClose,
  onAdjusted,
}: {
  /** Pre-selected when opened from a product row; absent from the page-level action. */
  product?: AdjustableProduct;
  /** Offered for selection when no product was pre-selected. */
  products: AdjustableProduct[];
  onClose: () => void;
  onAdjusted: (message: string) => void;
}) {
  const [productId, setProductId] = useState(product?.id ?? products[0]?.id ?? 0);
  const [type, setType] = useState<ManualStockMovementType>("RECEIPT");
  const [direction, setDirection] = useState<"in" | "out">("in");
  const [quantity, setQuantity] = useState("1");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const selected = product ?? products.find((candidate) => candidate.id === productId);
  const needsDirection = STOCK_MOVEMENT_DIRECTION[type] === "either";

  function signedDelta(amount: number): number {
    if (needsDirection) return direction === "in" ? amount : -amount;
    return STOCK_MOVEMENT_DIRECTION[type] === "in" ? amount : -amount;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const amount = Number(quantity);
    if (!selected || !Number.isInteger(amount) || amount <= 0) {
      setError("Indiquez une quantité entière supérieure à zéro.");
      return;
    }
    if (!reason.trim()) {
      setError("Indiquez un motif : il est conservé dans l'historique du produit.");
      return;
    }

    setSaving(true);
    setError("");
    try {
      const delta = signedDelta(amount);
      await apiFetch(`/api/products/${selected.id}/stock`, {
        method: "POST",
        body: JSON.stringify({ delta, type, reason: reason.trim() }),
      });
      onAdjusted(
        `${selected.name} : ${delta > 0 ? "+" : "−"}${Math.abs(delta)} (${STOCK_MOVEMENT_TYPE_LABELS[type]})`,
      );
      onClose();
    } catch (caught) {
      // UX-05: the entered values survive a refusal — the server may well be
      // refusing precisely the amount, and retyping it is not the fix.
      setError(caught instanceof ApiError ? caught.message : "Impossible d'ajuster le stock.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog title="Mouvement de stock" eyebrow="Inventaire" onClose={onClose}>
      <form onSubmit={submit}>
        <p className="modal-help">
          Chaque mouvement est enregistré avec son type, son motif et son auteur : c&apos;est ce qui
          rend le stock reconstructible.
        </p>

        {product ? (
          <p className="modal-help">
            <b>{product.name}</b> — {product.stock_quantity} unités en stock.
          </p>
        ) : (
          <label className="field-label">
            Produit
            <select
              className="input"
              value={productId}
              onChange={(event) => setProductId(Number(event.target.value))}
            >
              {products.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name} — {candidate.stock_quantity} unités
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="field-label">
          Type de mouvement
          <select
            className="input"
            value={type}
            onChange={(event) => setType(event.target.value as ManualStockMovementType)}
          >
            {MANUAL_STOCK_MOVEMENT_TYPES.map((value) => (
              <option key={value} value={value}>
                {STOCK_MOVEMENT_TYPE_LABELS[value]}
              </option>
            ))}
          </select>
        </label>

        {needsDirection && (
          <div className="movement-types" role="radiogroup" aria-label="Sens de la correction">
            <button
              type="button"
              role="radio"
              aria-checked={direction === "in"}
              onClick={() => setDirection("in")}
              className={direction === "in" ? "selected in" : ""}
            >
              <span>Ajouter</span>
              <small>Le stock réel est supérieur</small>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={direction === "out"}
              onClick={() => setDirection("out")}
              className={direction === "out" ? "selected out" : ""}
            >
              <span>Retirer</span>
              <small>Le stock réel est inférieur</small>
            </button>
          </div>
        )}

        <TextField
          label="Quantité"
          type="number"
          min="1"
          step="1"
          value={quantity}
          onChange={(event) => setQuantity(event.target.value)}
          hint={
            selected
              ? `Nouveau solde : ${selected.stock_quantity + signedDelta(Number(quantity) || 0)} unités.`
              : undefined
          }
          autoFocus
          required
        />

        <TextField
          label="Motif"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder={type === "LOSS" ? "Ex. Verre cassé" : "Ex. Livraison du mardi"}
          required
        />

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}

        <button
          className="primary-button"
          type="submit"
          disabled={saving || !selected}
          style={{ width: "100%", marginTop: 20 }}
        >
          <PackagePlus size={18} aria-hidden="true" />
          {saving ? "Enregistrement…" : "Enregistrer le mouvement"}
        </button>
      </form>
    </Dialog>
  );
}
