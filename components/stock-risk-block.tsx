"use client";

import { useState } from "react";
import { AsyncSection } from "@/components/ui/async-section";
import { StockAdjustModal, type AdjustableProduct } from "@/components/stock-adjust-modal";
import { apiFetch } from "@/lib/client/api";
import { useAsyncData } from "@/lib/client/use-async-data";

interface StockRiskProduct {
  id: number;
  name: string;
  stockQuantity: number;
  alertThreshold: number;
  categoryName: string | null;
}

interface StockAtRisk {
  outOfStock: StockRiskProduct[];
  lowStock: StockRiskProduct[];
}

/**
 * BI-10: "ruptures, sous-seuils et actions de réapprovisionnement."
 * Acceptance, verbatim: "alerte ouvre le produit et son formulaire de
 * mouvement" — each row *is* the action, not a link to one: clicking it
 * opens `StockAdjustModal` (`STK-05`) pre-selected on that exact product,
 * the same dialog `/stock` already uses, so recording a delivery here is
 * the same real write, not a shortcut that skips the ledger.
 */
export function StockRiskBlock() {
  const query = useAsyncData(() => apiFetch<StockAtRisk>("/api/stock-risk"), []);
  const [adjusting, setAdjusting] = useState<AdjustableProduct | null>(null);

  function openAdjustment(product: StockRiskProduct) {
    setAdjusting({ id: product.id, name: product.name, stock_quantity: product.stockQuantity });
  }

  return (
    <>
      <div className="section-title">
        <div>
          <h2>Stock à risque</h2>
          <p className="eyebrow">Ruptures et produits sous le seuil d&apos;alerte</p>
        </div>
      </div>
      <AsyncSection
        state={query.state}
        onRetry={query.refetch}
        isEmpty={(data) => data.outOfStock.length === 0 && data.lowStock.length === 0}
        emptyMessage="Aucun produit en rupture ou sous le seuil d'alerte."
      >
        {(data) => (
          <div className="history-card">
            {[...data.outOfStock, ...data.lowStock].map((product) => (
              <button
                type="button"
                key={product.id}
                className="order-row"
                onClick={() => openAdjustment(product)}
              >
                <div>
                  <b>{product.name}</b>
                  <small>{product.categoryName ?? "Sans catégorie"}</small>
                </div>
                <b className={product.stockQuantity === 0 ? "out" : "in"}>
                  {product.stockQuantity === 0
                    ? "Rupture"
                    : `${product.stockQuantity} / ${product.alertThreshold}`}
                </b>
              </button>
            ))}
          </div>
        )}
      </AsyncSection>
      {adjusting && (
        <StockAdjustModal
          product={adjusting}
          products={[]}
          onClose={() => setAdjusting(null)}
          onAdjusted={() => {
            setAdjusting(null);
            // A receipt may have taken this product out of the risk lists
            // entirely — the block has to reflect that itself, not wait
            // for a page reload nobody is going to trigger.
            query.refetch();
          }}
        />
      )}
    </>
  );
}
