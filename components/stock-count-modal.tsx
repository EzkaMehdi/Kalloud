"use client";

import { ClipboardCheck } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import { Dialog } from "@/components/ui/dialog";
import { TextField } from "@/components/ui/text-field";
import { ApiError, apiFetch } from "@/lib/client/api";

export interface CountableProduct {
  id: number;
  name: string;
  stock_quantity: number;
}

interface StockCountEntry {
  id: string;
  theoretical_quantity: number;
  counted_quantity: number;
  difference: number;
  note: string | null;
  counted_by_name: string | null;
  created_at: string;
}

/**
 * STK-07/DEC-06: a physical count. The user states what is on the shelf; the
 * system works out the écart and writes the `CORRECTION` that explains it.
 *
 * Deliberately not a mode of the adjustment dialog. An adjustment says "move
 * the balance by this much" and a count says "the balance *is* this" — the
 * only place an absolute number is the honest input. Folding them together
 * would put the one dangerous question ("what is the new total?") next to
 * the one that is safe to ask.
 *
 * The history below the form is the acceptance criterion itself: stock
 * avant, compté, différence, auteur et date, consultables — and it is what
 * makes a count that *matched* worth performing, since it leaves no
 * movement to point at.
 */
export function StockCountModal({
  product,
  onClose,
  onCounted,
}: {
  product: CountableProduct;
  onClose: () => void;
  onCounted: (message: string) => void;
}) {
  const [counted, setCounted] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [history, setHistory] = useState<StockCountEntry[] | null>(null);

  useEffect(() => {
    apiFetch<StockCountEntry[]>(`/api/products/${product.id}/stock-counts`)
      .then(setHistory)
      // A history that cannot be loaded must not block the count itself:
      // the shelf has been counted either way, and refusing to record it
      // would lose the only figure a person actually produced.
      .catch(() => setHistory([]));
  }, [product.id]);

  const parsed = Number(counted);
  const difference =
    counted.trim() !== "" && Number.isInteger(parsed) ? parsed - product.stock_quantity : null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (counted.trim() === "" || !Number.isInteger(parsed) || parsed < 0) {
      setError("Indiquez la quantité comptée (0 accepté).");
      return;
    }

    setSaving(true);
    setError("");
    try {
      await apiFetch(`/api/products/${product.id}/stock-counts`, {
        method: "POST",
        body: JSON.stringify({
          countedQuantity: parsed,
          ...(note.trim() ? { note: note.trim() } : {}),
        }),
      });
      onCounted(
        difference === 0
          ? `${product.name} : comptage conforme (${parsed} unités)`
          : `${product.name} : écart de ${difference! > 0 ? "+" : "−"}${Math.abs(difference!)} corrigé`,
      );
      onClose();
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : "Impossible d'enregistrer le comptage.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog title="Inventaire" eyebrow="Comptage physique" onClose={onClose}>
      <form onSubmit={submit}>
        <p className="modal-help">
          Comptez les unités réellement présentes. L&apos;écart avec le stock théorique est calculé
          et corrigé automatiquement, avec votre nom et la date.
        </p>

        <div className="closing-summary">
          <div>
            <span>{product.name} — stock théorique</span>
            <b>{product.stock_quantity} unités</b>
          </div>
        </div>

        <TextField
          label="Quantité comptée"
          type="number"
          min="0"
          step="1"
          value={counted}
          onChange={(event) => setCounted(event.target.value)}
          placeholder="Ex. 8"
          autoFocus
          required
        />

        {difference !== null && (
          <p className="modal-help" role="status" aria-live="polite">
            {difference === 0 ? (
              <>Comptage conforme : aucun écart, aucune correction ne sera enregistrée.</>
            ) : (
              <>
                Écart de{" "}
                <b>
                  {difference > 0 ? "+" : "−"}
                  {Math.abs(difference)}
                </b>{" "}
                — une correction sera enregistrée pour amener le stock à {parsed} unités.
              </>
            )}
          </p>
        )}

        <TextField
          label="Note (facultative)"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Ex. Inventaire de fin de mois"
        />

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}

        <button
          className="primary-button"
          type="submit"
          disabled={saving}
          style={{ width: "100%", marginTop: 20 }}
        >
          <ClipboardCheck size={18} aria-hidden="true" />
          {saving ? "Enregistrement…" : "Enregistrer le comptage"}
        </button>
      </form>

      <div className="section-title" style={{ marginTop: 24 }}>
        <div>
          <h2>Comptages précédents</h2>
          <p className="eyebrow">Stock avant, compté, écart, auteur et date</p>
        </div>
      </div>
      {history === null ? (
        <p className="stock-meta" role="status">
          Chargement de l&apos;historique…
        </p>
      ) : history.length === 0 ? (
        <p className="stock-meta" role="status">
          Ce produit n&apos;a jamais été compté.
        </p>
      ) : (
        <div className="history-card">
          {history.map((entry) => (
            <div className="movement" key={entry.id}>
              <div>
                <b>
                  {entry.theoretical_quantity} → {entry.counted_quantity} unités
                </b>
                <small>
                  {new Intl.DateTimeFormat("fr-FR", {
                    day: "numeric",
                    month: "short",
                    hour: "2-digit",
                    minute: "2-digit",
                  }).format(new Date(entry.created_at))}
                  {entry.counted_by_name ? ` · ${entry.counted_by_name}` : ""}
                  {entry.note ? ` · ${entry.note}` : ""}
                </small>
              </div>
              <b className={entry.difference === 0 ? "" : entry.difference > 0 ? "in" : "out"}>
                {entry.difference === 0
                  ? "conforme"
                  : `${entry.difference > 0 ? "+" : "−"}${Math.abs(entry.difference)}`}
              </b>
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}
