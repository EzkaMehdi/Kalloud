"use client";

import { useState } from "react";
import { Dialog } from "@/components/ui/dialog";
import { AsyncSection } from "@/components/ui/async-section";
import { TextField } from "@/components/ui/text-field";
import { ApiError, apiFetch } from "@/lib/client/api";
import { useAsyncData } from "@/lib/client/use-async-data";

/**
 * ORD-09/ORD-10: the receipt for one order, and the refund action.
 *
 * Everything shown comes from `GET /api/orders/:id/receipt`, which reads
 * the persisted rows — this component never recomputes a total or a tax
 * from the catalog, because the whole point of a receipt is to state what
 * was charged rather than what would be charged now.
 */

interface ReceiptLine {
  product_name: string;
  quantity: number;
  unit_price: string;
  line_total: string;
  tax_rate_percent: string | null;
  notes: string | null;
}

interface TaxBand {
  rate_percent: string;
  subtotal_excluding_tax: string;
  tax: string;
  total_including_tax: string;
}

interface PaymentLine {
  id: number;
  type: "CHARGE" | "REFUND";
  method: "CASH" | "CARD";
  amount: string;
  created_at: string;
}

interface Receipt {
  order_number: number;
  status: string;
  table_name: string | null;
  created_at: string;
  paid_at: string | null;
  served_by: string | null;
  notes: string | null;
  lines: ReceiptLine[];
  subtotal_amount: string | null;
  tax_amount: string | null;
  total_amount: string;
  tax_bands: TaxBand[];
  payments: PaymentLine[];
  net_paid: { cash: string; card: string; total: string };
  refunded_amount: string;
}

const STATUS_LABELS: Record<string, string> = {
  OPEN: "En cours",
  PAID: "Encaissée",
  CANCELLED: "Annulée",
  REFUNDED: "Remboursée",
};

const eur = (value: string | number) => `${Number(value).toFixed(2).replace(".", ",")} €`;

export function ReceiptDialog({
  orderId,
  canRefund,
  onClose,
  onRefunded,
}: {
  orderId: number;
  /** DEC-07: `orders:refund` is OWNER/MANAGER only — a cashier sees the receipt but no refund action. */
  canRefund: boolean;
  onClose: () => void;
  onRefunded: () => void;
}) {
  const receiptQuery = useAsyncData(
    () => apiFetch<Receipt>(`/api/orders/${orderId}/receipt`),
    [orderId],
  );

  const [refunding, setRefunding] = useState(false);
  const [reason, setReason] = useState("");
  const [amount, setAmount] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // API-02: one key per intended refund, kept across retries — a refund
  // moves money, so a lost response must not be able to hand it back twice.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());

  async function confirmRefund() {
    if (!reason.trim()) {
      setError("Indiquez le motif du remboursement.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await apiFetch(`/api/orders/${orderId}/refund`, {
        method: "POST",
        idempotencyKey,
        // An empty amount means "everything still owed" — the server works
        // it out, rather than the browser doing arithmetic on a figure the
        // server already holds.
        body: JSON.stringify({
          reason: reason.trim(),
          ...(amount.trim() ? { amount: Number(amount).toFixed(2) } : {}),
        }),
      });
      setIdempotencyKey(crypto.randomUUID());
      onRefunded();
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : "Impossible d'enregistrer le remboursement.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog title="Justificatif" eyebrow="Détail de la commande" onClose={onClose}>
      <AsyncSection state={receiptQuery.state} onRetry={receiptQuery.refetch}>
        {(receipt) => (
          <>
            <div className="receipt-head">
              <div>
                <b>Commande #{receipt.order_number}</b>
                <small>
                  {receipt.table_name ?? "Vente directe"} ·{" "}
                  {STATUS_LABELS[receipt.status] ?? receipt.status}
                </small>
              </div>
              <small>
                {new Intl.DateTimeFormat("fr-FR", {
                  day: "numeric",
                  month: "long",
                  hour: "2-digit",
                  minute: "2-digit",
                }).format(new Date(receipt.paid_at ?? receipt.created_at))}
              </small>
            </div>
            {/* ORD-08: the acceptance criterion is that a manager can tell
                who did this — so the name is on the document, not only in
                the audit log. */}
            {receipt.served_by && <p className="stock-meta">Servi par {receipt.served_by}</p>}
            {receipt.notes && <p className="stock-meta">Note : {receipt.notes}</p>}

            <div className="ticket">
              {receipt.lines.map((line, index) => (
                <div className="ticket-line" key={index}>
                  <div>
                    <b>
                      {line.quantity} × {line.product_name}
                    </b>
                    <small>
                      {eur(line.unit_price)}
                      {line.tax_rate_percent !== null &&
                        ` · TVA ${Number(line.tax_rate_percent).toFixed(2).replace(".", ",")} %`}
                    </small>
                    {line.notes && <small>{line.notes}</small>}
                  </div>
                  <b>{eur(line.line_total)}</b>
                </div>
              ))}
              <div className="ticket-total">
                <span>Total TTC</span>
                <span>{eur(receipt.total_amount)}</span>
              </div>
            </div>

            {receipt.tax_bands.length > 0 ? (
              <div className="closing-summary">
                {receipt.tax_bands.map((band) => (
                  <div key={band.rate_percent}>
                    <span>TVA {Number(band.rate_percent).toFixed(2).replace(".", ",")} %</span>
                    <b>
                      {eur(band.subtotal_excluding_tax)} HT + {eur(band.tax)}
                    </b>
                  </div>
                ))}
              </div>
            ) : (
              receipt.tax_amount && (
                // Lines sold before ORD-09 carry no rate, so no honest
                // breakdown exists — the total the order does hold is shown
                // instead of a reconstructed split (see migration 0013).
                <p className="stock-meta">
                  TVA totale {eur(receipt.tax_amount)} — détail par taux non enregistré pour cette
                  commande.
                </p>
              )
            )}

            <div className="closing-summary">
              {receipt.payments.map((payment) => (
                <div key={payment.id}>
                  <span>
                    {payment.type === "REFUND" ? "Remboursement" : "Paiement"} ·{" "}
                    {payment.method === "CASH" ? "Espèces" : "Carte"}
                  </span>
                  <b>
                    {payment.type === "REFUND" ? "−" : ""}
                    {eur(payment.amount)}
                  </b>
                </div>
              ))}
              <div>
                <span>Net encaissé</span>
                <b>{eur(receipt.net_paid.total)}</b>
              </div>
            </div>

            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}

            {canRefund &&
              receipt.status !== "CANCELLED" &&
              Number(receipt.net_paid.total) > 0 &&
              (refunding ? (
                <div className="cancel-ticket">
                  <TextField
                    label="Motif du remboursement"
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    placeholder="Ex. Produit renvoyé"
                    autoFocus
                    required
                  />
                  <TextField
                    label={`Montant (€) — vide pour tout rembourser (${eur(receipt.net_paid.total)})`}
                    inputMode="decimal"
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={amount}
                    onChange={(event) => setAmount(event.target.value)}
                    placeholder="Laisser vide pour le total"
                  />
                  <div className="cancel-actions">
                    <button
                      onClick={() => {
                        setRefunding(false);
                        setError("");
                      }}
                      disabled={saving}
                    >
                      Revenir
                    </button>
                    <button onClick={confirmRefund} disabled={saving} className="danger-button">
                      {saving ? "Remboursement…" : "Confirmer le remboursement"}
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setRefunding(true)}
                  className="link-button"
                  style={{ width: "100%", marginTop: 12 }}
                >
                  Rembourser cette commande
                </button>
              ))}
          </>
        )}
      </AsyncSection>
    </Dialog>
  );
}
