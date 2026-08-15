"use client";

import { ClipboardCheck, PackagePlus, Search } from "lucide-react";
import { useState } from "react";
import { AsyncSection } from "@/components/ui/async-section";
import { Shell } from "@/components/shell";
import { StockAdjustModal } from "@/components/stock-adjust-modal";
import { StockCountModal } from "@/components/stock-count-modal";
import { apiFetch } from "@/lib/client/api";
import { useAsyncData } from "@/lib/client/use-async-data";
import { can } from "@/lib/authz";
import { useCurrentUser } from "@/lib/client/use-current-user";

interface Product {
  id: number;
  name: string;
  category: string | null;
  price: string;
  stock_quantity: number;
  alert_threshold: number;
}

export default function Stock() {
  // STK-08: stock is the screen most likely to be changed from somewhere
  // else — a delivery counted on a tablet, a sale settled at the till — so
  // it re-reads when the tab comes back rather than trusting what it loaded.
  const productsQuery = useAsyncData(() => apiFetch<Product[]>("/api/products"), [], {
    revalidateOnFocus: true,
  });
  const user = useCurrentUser();
  const canAdjustStock = user ? can(user.role, "stock:adjust") : false;
  const [filter, setFilter] = useState("");
  const [notice, setNotice] = useState("");

  /**
   * STK-05: `null` means the dialog is closed, a product means it was opened
   * from that row, and `"any"` means it was opened from the page-level
   * action and must ask which product first.
   */
  const [adjustingId, setAdjustingId] = useState<number | "any" | null>(null);
  /** STK-07: the physical count, which states the shelf rather than a delta. */
  const [countingId, setCountingId] = useState<number | null>(null);

  /**
   * STK-08: the open dialog looks its product up in the current list on every
   * render, instead of holding the copy that existed when it was opened.
   *
   * Storing the object froze it: once the list re-read itself (a focus
   * revalidation, another tab's count), the row behind the dialog updated
   * while the dialog kept showing the balance it had captured — so the
   * "stock théorique" a user counted against could be stale until they
   * closed and reopened it. The server was never fooled, since it re-reads
   * the balance under lock (STK-07), but the figure on screen was.
   */
  const products = productsQuery.state.status === "success" ? productsQuery.state.data : [];
  const adjusting =
    adjustingId === "any" ? "any" : (products.find((item) => item.id === adjustingId) ?? null);
  const counting = products.find((item) => item.id === countingId) ?? null;

  function adjusted(message: string) {
    productsQuery.refetch();
    setNotice(message);
    setTimeout(() => setNotice(""), 4000);
  }

  return (
    <Shell>
      <div className="page-head">
        <div>
          <p className="eyebrow">Inventaire</p>
          <h1>Les stocks</h1>
        </div>
        {/* STK-05: the prototype had this button call
            `alert("Sélectionnez un produit pour le recharger.")` — an action
            whose whole behaviour was to tell you to go and do something
            else. UX-01 removed it rather than make it real; the acceptance
            criterion ("mène à un vrai parcours") is about giving it back its
            meaning, so it opens the same dialog and asks which product. */}
        {canAdjustStock && (
          <button className="soft-button" onClick={() => setAdjustingId("any")}>
            <PackagePlus size={18} aria-hidden="true" />
            Recharger
          </button>
        )}
      </div>

      {notice && (
        <div className="status" role="status" aria-live="polite" style={{ marginBottom: 12 }}>
          <span className="dot" aria-hidden="true" />
          {notice}
        </div>
      )}

      <AsyncSection state={productsQuery.state} onRetry={productsQuery.refetch}>
        {(products) => {
          const alerts = products.filter(
            (product) => product.stock_quantity <= product.alert_threshold,
          ).length;
          const visible = products.filter((product) =>
            product.name.toLowerCase().includes(filter.toLowerCase()),
          );
          return (
            <>
              <div className="section-title">
                <div>
                  <h2>Produits</h2>
                  <p className="eyebrow">{alerts} alerte(s) à surveiller</p>
                </div>
              </div>
              <label className="visually-hidden" htmlFor="stock-search">
                Rechercher un produit
              </label>
              <div style={{ position: "relative", marginBottom: 12 }}>
                <Search
                  size={18}
                  style={{ position: "absolute", left: 14, top: 15, color: "#526058" }}
                  aria-hidden="true"
                />
                <input
                  id="stock-search"
                  className="input"
                  style={{ paddingLeft: 43 }}
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  placeholder="Rechercher un produit"
                />
              </div>
              {/* STK-08: two different facts, told apart. An establishment
                  with no catalogue at all used to be shown "Aucun produit ne
                  correspond à «  »" — a search result for a search nobody
                  ran, which reads as a bug rather than as an onboarding
                  step. */}
              {products.length === 0 ? (
                <div className="async-state" role="status">
                  Aucun produit dans le catalogue. Ajoutez-en depuis les réglages pour suivre leur
                  stock.
                </div>
              ) : visible.length === 0 ? (
                <div className="async-state" role="status">
                  Aucun produit ne correspond à « {filter} ».
                </div>
              ) : (
                <div className="stock-card">
                  {visible.map((product) => {
                    const state =
                      product.stock_quantity === 0
                        ? "empty"
                        : product.stock_quantity <= product.alert_threshold
                          ? "low"
                          : "ok";
                    const label =
                      state === "empty" ? "Rupture" : state === "low" ? "À recharger" : "En stock";
                    return (
                      <div className="stock-row" key={product.id}>
                        <div>
                          <span className="stock-name">{product.name}</span>
                          <span className="stock-meta">
                            {product.category ?? "Sans catégorie"} ·{" "}
                            {Number(product.price).toFixed(2)} € · seuil {product.alert_threshold}
                          </span>
                        </div>
                        <div className="stock-value">
                          <b>{product.stock_quantity} unités</b>
                          {canAdjustStock ? (
                            <>
                              <button
                                onClick={() => setCountingId(product.id)}
                                className="soft-button"
                                aria-label={`Compter ${product.name}`}
                              >
                                <ClipboardCheck size={15} aria-hidden="true" />
                                Compter
                              </button>
                              <button
                                onClick={() => setAdjustingId(product.id)}
                                className={`stock-alert ${state}`}
                                aria-label={`${label}, ${product.stock_quantity} unités. Ajouter du stock pour ${product.name}`}
                              >
                                {label} · +
                              </button>
                            </>
                          ) : (
                            <span className={`stock-alert ${state}`}>{label}</span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          );
        }}
      </AsyncSection>

      {adjusting && (
        <StockAdjustModal
          product={adjusting === "any" ? undefined : adjusting}
          products={products}
          onClose={() => setAdjustingId(null)}
          onAdjusted={adjusted}
        />
      )}
      {counting && (
        <StockCountModal
          product={counting}
          onClose={() => setCountingId(null)}
          onCounted={adjusted}
        />
      )}
    </Shell>
  );
}
