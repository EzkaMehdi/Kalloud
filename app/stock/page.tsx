"use client";

import { Search } from "lucide-react";
import { useState } from "react";
import { AsyncSection } from "@/components/ui/async-section";
import { Shell } from "@/components/shell";
import { apiFetch, ApiError } from "@/lib/client/api";
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
  const productsQuery = useAsyncData(() => apiFetch<Product[]>("/api/products"), []);
  const user = useCurrentUser();
  const canAdjustStock = user ? can(user.role, "stock:adjust") : false;
  const [filter, setFilter] = useState("");
  const [notice, setNotice] = useState("");

  /**
   * TODO(STK-05, phase 5B): replaces the native prompt()/alert() pair with a
   * proper contextual dialog carrying a reason. Kept as-is for phase 2,
   * which only had to make the underlying call authenticated, scoped and
   * non-silent on failure (SEC-03/04/06, UX-01) — not redesign the
   * interaction itself.
   */
  async function addStock(product: Product) {
    const raw = window.prompt(`Quantité à ajouter pour ${product.name}`, "1");
    const amount = Number(raw);
    if (!raw || !Number.isFinite(amount) || amount <= 0) return;
    try {
      await apiFetch(`/api/products/${product.id}/stock`, {
        method: "PATCH",
        body: JSON.stringify({ quantity: product.stock_quantity + amount }),
      });
      productsQuery.refetch();
    } catch (caught) {
      setNotice(
        caught instanceof ApiError ? caught.message : "Impossible de mettre à jour le stock.",
      );
      setTimeout(() => setNotice(""), 4000);
    }
  }

  return (
    <Shell>
      <div className="page-head">
        <div>
          <p className="eyebrow">Inventaire</p>
          <h1>Les stocks</h1>
        </div>
      </div>

      {notice && (
        <p className="form-error" role="alert">
          {notice}
        </p>
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
              {visible.length === 0 ? (
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
                            <button
                              onClick={() => addStock(product)}
                              className={`stock-alert ${state}`}
                              aria-label={`${label}, ${product.stock_quantity} unités. Ajouter du stock pour ${product.name}`}
                            >
                              {label} · +
                            </button>
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
    </Shell>
  );
}
