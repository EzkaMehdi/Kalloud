"use client";

import { Minus, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { Dialog } from "@/components/ui/dialog";
import { ApiError, apiFetch } from "@/lib/client/api";

/**
 * TODO(SALE-01, SALE-04 — phase 3): this catalog is a local constant, not
 * the real, scoped product list from /api/products, and its ids do not
 * reliably match the seeded catalog (audit finding P0-03). Loading the real
 * catalog here — so the product shown, the price charged and the stock
 * decremented are always the same row — is exactly SALE-04's job. Left
 * as-is for phase 1/2, which only had to make the *checkout call itself*
 * authenticated and location-scoped (SEC-03/SEC-04/SEC-06), not rebuild the
 * sales UI's data source.
 */
const products = [
  { id: 1, name: "Chicha Signature", price: 25, cat: "Chichas" },
  { id: 2, name: "Chicha Classique", price: 20, cat: "Chichas" },
  { id: 3, name: "Thé à la menthe", price: 4, cat: "Boissons" },
  { id: 4, name: "Mojito passion", price: 8, cat: "Boissons" },
  { id: 7, name: "Café latte", price: 5, cat: "Boissons" },
  { id: 5, name: "Brunch Kalloud", price: 19, cat: "Plats" },
  { id: 6, name: "Tiramisu maison", price: 7, cat: "Desserts" },
];
const cats = ["Tout", "Chichas", "Boissons", "Plats", "Desserts"];

/**
 * TODO(SALE-05, phase 3): "Mixte" is deliberately absent. It used to be
 * offered here and sent `MIXED` with both amounts at zero, which the server
 * then recorded as a full card payment (audit finding P0-02) — a payment
 * mode that looked supported and silently falsified the cash journal.
 * API-01's checkout schema now refuses that payload outright, and SALE-05
 * adds the real split input that will bring the option back.
 */
const paymentOptions = [
  { value: "CB", label: "CB" },
  { value: "Espèces", label: "Espèces" },
] as const;

type Item = { id: number; name: string; price: number; quantity: number };

export function OrderDrawer({
  table,
  tableId,
  onClose,
  onComplete,
}: {
  table: string;
  tableId: number | null;
  onClose: () => void;
  onComplete: (total: number) => void;
}) {
  const [category, setCategory] = useState("Tout");
  const [items, setItems] = useState<Item[]>([]);
  const [payment, setPayment] = useState<(typeof paymentOptions)[number]["value"]>("CB");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const filtered = products.filter((p) => category === "Tout" || p.cat === category);
  const total = useMemo(
    () => items.reduce((sum, item) => sum + item.price * item.quantity, 0),
    [items],
  );

  function add(product: { id: number; name: string; price: number }) {
    setItems((old) => {
      const existing = old.find((item) => item.id === product.id);
      return existing
        ? old.map((item) =>
            item.id === product.id ? { ...item, quantity: item.quantity + 1 } : item,
          )
        : [...old, { ...product, quantity: 1 }];
    });
  }

  function delta(name: string, change: number) {
    setItems((old) =>
      old.flatMap((item) =>
        item.name !== name
          ? [item]
          : item.quantity + change > 0
            ? [{ ...item, quantity: item.quantity + change }]
            : [],
      ),
    );
  }

  async function checkout() {
    setSaving(true);
    setError("");
    try {
      const method = payment === "CB" ? "CARD" : "CASH";
      // Amounts go out as fixed 2-decimal strings: summing prices in
      // JavaScript can yield 9.989999999999998, which the server's money
      // schema rightly refuses (DEC-05). SALE-06 removes the question
      // entirely by taking the total from the server's response.
      const amount = total.toFixed(2);
      await apiFetch("/api/checkout", {
        method: "POST",
        body: JSON.stringify({
          tableId,
          items: items.map((item) => ({ productId: item.id, quantity: item.quantity })),
          paymentMethod: method,
          cashAmount: method === "CASH" ? amount : "0.00",
          cardAmount: method === "CARD" ? amount : "0.00",
        }),
      });
      onComplete(total);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Erreur d'encaissement.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog title={table} eyebrow="Nouvelle commande" onClose={onClose}>
      <div className="product-cats" role="tablist" aria-label="Catégories de produits">
        {cats.map((cat) => (
          <button
            key={cat}
            role="tab"
            aria-selected={category === cat}
            onClick={() => setCategory(cat)}
            className={`cat ${category === cat ? "active" : ""}`}
          >
            {cat}
          </button>
        ))}
      </div>
      <div className="products">
        {filtered.map((product) => (
          <button onClick={() => add(product)} className="product" key={product.id}>
            <b>{product.name}</b>
            <span>{product.price.toFixed(2)} €</span>
          </button>
        ))}
      </div>
      <div className="ticket">
        <h2>Articles sélectionnés</h2>
        {items.length === 0 ? (
          <p className="stock-meta">Touchez un article pour l&apos;ajouter.</p>
        ) : (
          items.map((item) => (
            <div className="ticket-line" key={item.name}>
              <div>
                <b>{item.name}</b>
                <div className="quantity">
                  <button
                    onClick={() => delta(item.name, -1)}
                    aria-label={`Retirer un ${item.name}`}
                  >
                    <Minus size={14} />
                  </button>
                  <span aria-live="polite">{item.quantity}</span>
                  <button
                    onClick={() => delta(item.name, 1)}
                    aria-label={`Ajouter un ${item.name}`}
                  >
                    <Plus size={14} />
                  </button>
                </div>
              </div>
              <b>{(item.price * item.quantity).toFixed(2)} €</b>
            </div>
          ))
        )}
        <div className="ticket-total">
          <span>Total</span>
          <span>{total.toFixed(2)} €</span>
        </div>
      </div>
      <div className="checkout" role="radiogroup" aria-label="Moyen de paiement">
        {paymentOptions.map((option) => (
          <button
            key={option.value}
            role="radio"
            aria-checked={payment === option.value}
            className={`pay-option ${payment === option.value ? "active" : ""}`}
            onClick={() => setPayment(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <button
        disabled={!items.length || saving}
        onClick={checkout}
        className="primary-button"
        style={{ width: "100%", marginTop: 12, opacity: items.length ? 1 : 0.45 }}
      >
        {saving ? "Encaissement…" : `Encaisser · ${total.toFixed(2)} €`}
      </button>
    </Dialog>
  );
}
