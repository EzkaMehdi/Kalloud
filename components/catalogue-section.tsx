"use client";

import { Plus } from "lucide-react";
import { FormEvent, useState } from "react";
import { AsyncSection } from "@/components/ui/async-section";
import { TextField } from "@/components/ui/text-field";
import { apiFetch } from "@/lib/client/api";
import type { AsyncState } from "@/lib/client/use-async-data";

export interface CatalogueProduct {
  id: number;
  name: string;
  category: string | null;
  price: string;
  stock_quantity: number;
  alert_threshold: number;
  is_active: boolean;
}

export interface CatalogueCategory {
  id: number;
  name: string;
}

/**
 * SAAS-01: the catalogue's own administration screen.
 *
 * `CFG-02` delivered the service, the API and the audit trail for creating
 * and editing a product, and its own note says so — but no screen ever
 * called them. The configuration page's header comment assumed "products
 * keep their existing screen", which is the stock page, and that one only
 * *adjusts quantities* (STK-04/05): it has never been able to create a
 * product or change a price.
 *
 * That gap is what makes it this ticket's business. SAAS-01's acceptance is
 * "aucun SQL ou seed manuel pour un nouveau client", and a customer who can
 * add tables but not a single product owns a till with nothing to sell —
 * they would need the SQL console this ticket exists to remove.
 */
export function CatalogueSection({
  productsState,
  categories,
  canManage,
  onChanged,
  onRetry,
  onError,
  onNotice,
}: {
  productsState: AsyncState<CatalogueProduct[]>;
  categories: CatalogueCategory[];
  canManage: boolean;
  onChanged: () => void;
  onRetry: () => void;
  onError: (caught: unknown, fallback: string) => void;
  onNotice: (message: string) => void;
}) {
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [unit, setUnit] = useState("");
  const [stock, setStock] = useState("");
  const [threshold, setThreshold] = useState("");
  const [saving, setSaving] = useState(false);

  async function create(event: FormEvent) {
    event.preventDefault();
    const amount = Number(price);
    if (!name.trim() || price.trim() === "" || Number.isNaN(amount) || amount < 0) {
      onError(null, "Indiquez au moins un nom et un prix valide.");
      return;
    }
    setSaving(true);
    try {
      await apiFetch("/api/products", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          // DEC-05 wants exactly two decimals; sending the raw input would
          // let "3.5" through as a price the server then rejects.
          price: amount.toFixed(2),
          categoryId: categoryId ? Number(categoryId) : null,
          ...(unit.trim() ? { unit: unit.trim() } : {}),
          ...(stock.trim() ? { stockQuantity: Number(stock) } : {}),
          ...(threshold.trim() ? { alertThreshold: Number(threshold) } : {}),
        }),
      });
      // UX-05 in reverse: a *successful* create is the one moment clearing
      // the form is right, since the next product is a different one.
      setName("");
      setPrice("");
      setUnit("");
      setStock("");
      setThreshold("");
      onChanged();
      onNotice("Produit créé");
    } catch (caught) {
      onError(caught, "Impossible de créer le produit.");
    } finally {
      setSaving(false);
    }
  }

  async function setActivation(product: CatalogueProduct, isActive: boolean) {
    try {
      await apiFetch(`/api/products/${product.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive }),
      });
      onChanged();
      onNotice(isActive ? `${product.name} remis en vente` : `${product.name} retiré de la carte`);
    } catch (caught) {
      onError(caught, "Impossible de modifier le produit.");
    }
  }

  return (
    <>
      <div className="section-title">
        <div>
          <h2>Catalogue</h2>
          <p className="eyebrow">
            Un produit retiré reste dans l’historique des ventes — il n’est jamais supprimé
          </p>
        </div>
      </div>
      <AsyncSection
        state={productsState}
        onRetry={onRetry}
        isEmpty={(data) => data.length === 0}
        emptyMessage="Aucun produit. Ajoutez-en un ci-dessous pour pouvoir encaisser."
      >
        {(products) => (
          <div className="history-card">
            {products.map((product) => (
              <div className="order-row" key={product.id}>
                <div>
                  <b>{product.name}</b>
                  <small>
                    {product.category ?? "Sans catégorie"} ·{" "}
                    {Number(product.price).toFixed(2).replace(".", ",")} € ·{" "}
                    {product.stock_quantity} en stock
                    {product.is_active ? "" : " · retiré de la carte"}
                  </small>
                </div>
                {canManage && (
                  <button
                    type="button"
                    className="soft-button"
                    onClick={() => setActivation(product, !product.is_active)}
                  >
                    {product.is_active ? "Retirer" : "Remettre en vente"}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </AsyncSection>

      {canManage && (
        <form onSubmit={create} className="history-card" style={{ padding: 16, marginTop: 12 }}>
          <TextField
            label="Nouveau produit"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Ex. Café allongé"
            required
          />
          <TextField
            label="Prix de vente (€)"
            type="number"
            min="0"
            step="0.01"
            value={price}
            onChange={(event) => setPrice(event.target.value)}
            placeholder="Ex. 2.50"
            required
          />
          <label className="field-label">
            Catégorie
            <select
              className="input"
              value={categoryId}
              onChange={(event) => setCategoryId(event.target.value)}
            >
              <option value="">Sans catégorie</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </label>
          <TextField
            label="Unité (facultatif)"
            value={unit}
            onChange={(event) => setUnit(event.target.value)}
            placeholder="Ex. bouteille"
          />
          <TextField
            label="Stock initial (facultatif)"
            type="number"
            min="0"
            step="1"
            value={stock}
            onChange={(event) => setStock(event.target.value)}
            hint="Enregistré comme un mouvement d’entrée, pour rester traçable."
          />
          <TextField
            label="Seuil d’alerte (facultatif)"
            type="number"
            min="0"
            step="1"
            value={threshold}
            onChange={(event) => setThreshold(event.target.value)}
            hint="En dessous de cette quantité, le produit est signalé à recharger."
          />
          <button className="primary-button" disabled={saving} style={{ width: "100%" }}>
            <Plus size={18} aria-hidden="true" />
            {saving ? "Création…" : "Ajouter au catalogue"}
          </button>
        </form>
      )}
    </>
  );
}
