"use client";

import { Minus, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { Dialog } from "@/components/ui/dialog";
import { AsyncSection } from "@/components/ui/async-section";
import { ApiError, apiFetch } from "@/lib/client/api";
import { useAsyncData } from "@/lib/client/use-async-data";

/**
 * SALE-01's catalog shape, narrowed to what this drawer actually reads.
 * Field names mirror the API response verbatim (snake_case, `price` as the
 * `DECIMAL` string Postgres stores) rather than importing
 * lib/repositories/products.ts's server-side type — same boundary
 * app/stock/page.tsx already draws, so a client component never pulls in a
 * module that talks to the database.
 */
interface CatalogProduct {
  id: number;
  name: string;
  price: string;
  category: string | null;
}

const ALL_CATEGORIES = "Tout";

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
  const [category, setCategory] = useState(ALL_CATEGORIES);
  const [items, setItems] = useState<Item[]>([]);
  const [payment, setPayment] = useState<(typeof paymentOptions)[number]["value"]>("CB");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  /**
   * API-02: one key per payment *attempt of this ticket*, not per HTTP
   * request. It is created when the drawer opens and deliberately kept
   * across failures and retries — that is precisely what lets the server
   * recognise a double-click, or a retry after a lost response, as the same
   * sale (DEC-08). A new key is only minted once the sale has succeeded and
   * the drawer is reused. SALE-08 builds the "état incertain / récupération"
   * experience on top of this.
   */
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());

  // SALE-01/SALE-04: the same scoped, real catalog the stock screen reads —
  // no separate constant that could drift from it (P0-03: the old local
  // catalog's ids didn't reliably match the seeded one at all).
  const productsQuery = useAsyncData(() => apiFetch<CatalogProduct[]>("/api/products"), []);

  // SALE-07 (later) is what makes an inactive/out-of-stock product visible
  // but non-addable; for now every product SALE-01 returns is shown and
  // addable, and checkout.ts (SALE-03) already refuses one that turns out
  // to be inactive or under-stocked when the sale is actually attempted.
  const categories = useMemo(() => {
    if (productsQuery.state.status !== "success") return [ALL_CATEGORIES];
    const names = new Set(
      productsQuery.state.data.map((product) => product.category).filter((name) => name !== null),
    );
    return [ALL_CATEGORIES, ...names];
  }, [productsQuery.state]);

  const total = useMemo(
    () => items.reduce((sum, item) => sum + item.price * item.quantity, 0),
    [items],
  );

  function add(product: CatalogProduct) {
    setItems((old) => {
      const existing = old.find((item) => item.id === product.id);
      if (existing) {
        return old.map((item) =>
          item.id === product.id ? { ...item, quantity: item.quantity + 1 } : item,
        );
      }
      return [
        ...old,
        { id: product.id, name: product.name, price: Number(product.price), quantity: 1 },
      ];
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
        idempotencyKey,
        body: JSON.stringify({
          tableId,
          items: items.map((item) => ({ productId: item.id, quantity: item.quantity })),
          paymentMethod: method,
          cashAmount: method === "CASH" ? amount : "0.00",
          cardAmount: method === "CARD" ? amount : "0.00",
        }),
      });
      // The sale is recorded; the next one is a different operation and
      // must not reuse this key.
      setIdempotencyKey(crypto.randomUUID());
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
        {categories.map((cat) => (
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
      <AsyncSection
        state={productsQuery.state}
        onRetry={productsQuery.refetch}
        isEmpty={(data) => data.length === 0}
        emptyMessage="Aucun produit configuré pour cet établissement."
      >
        {(products) => (
          <div className="products">
            {products
              .filter((product) => category === ALL_CATEGORIES || product.category === category)
              .map((product) => (
                <button onClick={() => add(product)} className="product" key={product.id}>
                  <b>{product.name}</b>
                  <span>{Number(product.price).toFixed(2)} €</span>
                </button>
              ))}
          </div>
        )}
      </AsyncSection>
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
