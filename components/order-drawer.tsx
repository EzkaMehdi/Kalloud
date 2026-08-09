"use client";

import { Minus, Plus } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { Dialog } from "@/components/ui/dialog";
import { AsyncSection } from "@/components/ui/async-section";
import { TextField } from "@/components/ui/text-field";
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
  is_available: boolean;
}

/** ORD-02's ticket shape, likewise narrowed to what the drawer reads. */
export interface TicketItem {
  id: number;
  product_id: number;
  product_name: string;
  quantity: number;
  unit_price: string;
  notes: string | null;
  is_available: boolean;
}

export interface Ticket {
  id: number;
  order_number: number;
  table_id: number | null;
  table_name: string | null;
  status: string;
  total_amount: string;
  version: number;
  items: TicketItem[];
}

const ALL_CATEGORIES = "Tout";

/**
 * SALE-05: "Mixte" used to send `MIXED` with both amounts at zero, which the
 * server recorded as a full card payment (audit finding P0-02) — a mode
 * that looked supported and silently falsified the cash journal. It is back
 * now that there is a real split input (below) and a server that verifies
 * the two amounts actually sum to the total (SALE-03) instead of trusting
 * whatever the client sent.
 */
const paymentOptions = [
  { value: "CB", label: "CB" },
  { value: "Espèces", label: "Espèces" },
  { value: "Mixte", label: "Mixte" },
] as const;

/** The line list as the drawer wants it saved — product ids and quantities, nothing priced. */
interface DraftLine {
  productId: number;
  quantity: number;
}

function toDraft(ticket: Ticket): DraftLine[] {
  return ticket.items.map((item) => ({ productId: item.product_id, quantity: item.quantity }));
}

export function OrderDrawer({
  ticket: initialTicket,
  onClose,
  onComplete,
  onCancelled,
}: {
  /**
   * ORD-04: the drawer is opened *on* a ticket that already exists
   * server-side, never on an empty local basket. That is what makes
   * "fermer, changer de route ou rafraîchir ne perd aucun article" true —
   * there is no client-only state for a refresh to lose.
   */
  ticket: Ticket;
  onClose: () => void;
  /**
   * SALE-08: `replayed` is true when this total came from a stored result
   * (DEC-08 recovery), not a sale the server just performed — callers use
   * it to say so, rather than showing an identical "nouvelle vente"
   * confirmation for what was actually a recovered retry.
   */
  onComplete: (total: number, replayed?: boolean) => void;
  /** ORD-06: the ticket was cancelled — the table is free and nothing was charged. */
  onCancelled: () => void;
}) {
  const [category, setCategory] = useState(ALL_CATEGORIES);
  const [ticket, setTicket] = useState<Ticket>(initialTicket);
  /**
   * ORD-05: what the cashier has asked for, which may briefly run ahead of
   * what the server has confirmed. Tapping a product should feel immediate;
   * the authoritative list is whatever `setTicket` last received back.
   */
  const [draft, setDraft] = useState<DraftLine[]>(() => toDraft(initialTicket));
  const [payment, setPayment] = useState<(typeof paymentOptions)[number]["value"]>("CB");
  // SALE-05: only meaningful when payment === "Mixte" — CB/Espèces derive
  // their amount entirely from the server-computed total (SALE-03 ignores
  // whatever a client sends for those two methods), so there is nothing for
  // the cashier to type for them.
  const [cashSplit, setCashSplit] = useState("");
  const [cardSplit, setCardSplit] = useState("");
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState("");
  /**
   * ORD-05/DEC-08: another device saved this ticket first. Not an error the
   * cashier caused and not something a retry fixes — the only honest move is
   * to show the server's current state, so the drawer offers exactly that
   * rather than letting a stale line list be re-sent.
   */
  const [conflict, setConflict] = useState(false);
  /**
   * SALE-08/DEC-08: true only for a network-layer failure (fetch itself
   * threw — the request may or may not have reached the server, and the
   * client has no way to tell). Distinct from a definitive server rejection
   * (bad payload, insufficient stock): those are known outcomes to correct,
   * this is an unknown outcome to check.
   */
  const [uncertain, setUncertain] = useState(false);
  /**
   * API-02: one key per payment *attempt of this ticket*, not per HTTP
   * request. Kept across failures and retries — that is precisely what lets
   * the server recognise a double-click, or a retry after a lost response,
   * as the same sale (DEC-08).
   */
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  /** ORD-06: the cancellation form, opened only on explicit intent. */
  const [cancelling, setCancelling] = useState(false);
  const [cancelReason, setCancelReason] = useState("");

  // SALE-01/SALE-04: the same scoped, real catalog the stock screen reads —
  // no separate constant that could drift from it (P0-03: the old local
  // catalog's ids didn't reliably match the seeded one at all).
  const productsQuery = useAsyncData(() => apiFetch<CatalogProduct[]>("/api/products"), []);

  /**
   * Saves run one at a time. A cashier tapping "+" three times quickly would
   * otherwise fire three writes against the same version, of which two are
   * guaranteed to lose the optimistic check and 409 — a conflict the user
   * never actually had. The queue collapses those into "save the latest
   * intent once the previous save has answered".
   */
  const inFlight = useRef(false);
  const queued = useRef<DraftLine[] | null>(null);

  const save = useCallback(
    async (lines: DraftLine[], version: number) => {
      if (inFlight.current) {
        // A save is already talking to the server. Record the newer intent
        // and let the loop below pick it up with the version the in-flight
        // save comes back with.
        queued.current = lines;
        return;
      }
      inFlight.current = true;
      setSyncing(true);
      try {
        let pending: DraftLine[] | null = lines;
        let currentVersion = version;
        // Sequential by design: each save must carry the version the
        // previous one produced, so awaiting inside the loop is the point
        // rather than something to parallelise away.
        while (pending) {
          const saved: Ticket = await apiFetch<Ticket>(`/api/tickets/${initialTicket.id}/items`, {
            method: "PUT",
            body: JSON.stringify({ version: currentVersion, items: pending }),
          });
          setTicket(saved);
          setDraft(toDraft(saved));
          setError("");
          currentVersion = saved.version;
          pending = queued.current;
          queued.current = null;
        }
      } catch (caught) {
        queued.current = null;
        if (caught instanceof ApiError && caught.status === 409) {
          setConflict(true);
          setError(caught.message);
        } else {
          setError(
            caught instanceof ApiError ? caught.message : "Impossible d'enregistrer le ticket.",
          );
        }
      } finally {
        inFlight.current = false;
        setSyncing(false);
      }
    },
    // `initialTicket.id` is stable for the drawer's lifetime: a different
    // ticket means a different drawer instance.
    [initialTicket.id],
  );

  const reload = useCallback(async () => {
    setSyncing(true);
    try {
      const fresh = await apiFetch<Ticket>(`/api/tickets/${initialTicket.id}`);
      setTicket(fresh);
      setDraft(toDraft(fresh));
      setConflict(false);
      setError("");
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Impossible de recharger le ticket.");
    } finally {
      setSyncing(false);
    }
  }, [initialTicket.id]);

  const categories = useMemo(() => {
    if (productsQuery.state.status !== "success") return [ALL_CATEGORIES];
    const names = new Set(
      productsQuery.state.data.map((product) => product.category).filter((name) => name !== null),
    );
    return [ALL_CATEGORIES, ...names];
  }, [productsQuery.state]);

  /**
   * SALE-06: the displayed total is the server's own `total_amount`, not a
   * client re-computation. While a save is in flight the two can disagree
   * for a moment — that is the honest state, and the "Enregistrement…"
   * indicator says so rather than showing a number nothing has confirmed.
   */
  const total = Number(ticket.total_amount);

  function mutate(next: DraftLine[]) {
    if (conflict) return;
    setDraft(next);
    void save(next, ticket.version);
  }

  function add(product: CatalogProduct) {
    // SALE-07: the button is already `disabled` for an unavailable product
    // (native disabled buttons never fire onClick), but guarding here too
    // costs nothing and means this function stays correct even if a future
    // caller stops going through that button.
    if (!product.is_available) return;
    const existing = draft.find((line) => line.productId === product.id);
    mutate(
      existing
        ? draft.map((line) =>
            line.productId === product.id ? { ...line, quantity: line.quantity + 1 } : line,
          )
        : [...draft, { productId: product.id, quantity: 1 }],
    );
  }

  function delta(productId: number, change: number) {
    mutate(
      draft.flatMap((line) =>
        line.productId !== productId
          ? [line]
          : line.quantity + change > 0
            ? [{ ...line, quantity: line.quantity + change }]
            : [],
      ),
    );
  }

  /**
   * ORD-06: a two-step cancellation — reveal the form, then confirm with a
   * motive. Not a `confirm()`: the motive is required, it is what the audit
   * log and the order row will carry, and a native dialog cannot collect it.
   */
  async function confirmCancel() {
    if (!cancelReason.trim()) {
      setError("Indiquez le motif de l'annulation.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await apiFetch(`/api/tickets/${ticket.id}/cancel`, {
        method: "POST",
        body: JSON.stringify({ reason: cancelReason.trim() }),
      });
      onCancelled();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Impossible d'annuler le ticket.");
    } finally {
      setSaving(false);
    }
  }

  async function checkout() {
    setError("");
    setUncertain(false);

    let paymentMethod: "CASH" | "CARD" | "MIXED";
    let cashAmount: string | undefined;
    let cardAmount: string | undefined;

    if (payment === "Mixte") {
      paymentMethod = "MIXED";
      const cash = Number(cashSplit);
      const card = Number(cardSplit);
      // UX-05: caught here, inline, before a network round-trip — not
      // because the server's own check (SALE-03) is any less final, but so
      // a typo shows up immediately next to the two fields instead of after
      // a request the server was always going to refuse anyway. Compared
      // in cents: 0.1 + 0.2 !== 0.3 in binary floating point, and DEC-05's
      // rule has no tolerance for that kind of near-miss.
      if (!cash || !card || cash <= 0 || card <= 0) {
        setError("Indiquez un montant espèces et un montant carte, tous deux supérieurs à zéro.");
        return;
      }
      if (Math.round(cash * 100) + Math.round(card * 100) !== Math.round(total * 100)) {
        setError(`La somme des deux montants doit être égale au total (${total.toFixed(2)} €).`);
        return;
      }
      cashAmount = cash.toFixed(2);
      cardAmount = card.toFixed(2);
    } else {
      paymentMethod = payment === "CB" ? "CARD" : "CASH";
    }

    setSaving(true);
    try {
      let replayed = false;
      const result = await apiFetch<{ order: { total_amount: string } }>("/api/checkout", {
        method: "POST",
        idempotencyKey,
        onResponseHeaders: (headers) => {
          replayed = headers.get("Idempotent-Replay") === "true";
        },
        // ORD-04: the sale names the ticket; its lines are read from the
        // database, not re-sent from here. Whatever this browser still has
        // in memory is irrelevant to what the customer is charged.
        body: JSON.stringify({
          orderId: ticket.id,
          paymentMethod,
          ...(cashAmount ? { cashAmount } : {}),
          ...(cardAmount ? { cardAmount } : {}),
        }),
      });
      setIdempotencyKey(crypto.randomUUID());
      onComplete(Number(result.order.total_amount), replayed);
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "NETWORK_ERROR") {
        // DEC-08's "pendant l'encaissement" row, verbatim: the client does
        // not know whether the server processed this request. The only safe
        // response is to change nothing about the next attempt — the same
        // idempotencyKey (untouched here) goes out again on the next click.
        setUncertain(true);
        setError(
          "Connexion perdue pendant l'encaissement. Impossible de confirmer si la vente a été enregistrée : cliquez sur « Vérifier le paiement » pour réessayer — sans risque de doublon.",
        );
      } else {
        setError(caught instanceof ApiError ? caught.message : "Erreur d'encaissement.");
        // SALE-07: the server's own message already names the product that
        // ran out — refetching turns that explanation into a visible state
        // change, greying the item out in the grid above.
        productsQuery.refetch();
      }
    } finally {
      setSaving(false);
    }
  }

  const eyebrow =
    ticket.items.length > 0
      ? `Ticket #${ticket.order_number} en cours`
      : `Ticket #${ticket.order_number}`;

  return (
    <Dialog title={ticket.table_name ?? "Vente directe"} eyebrow={eyebrow} onClose={onClose}>
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
                <button
                  onClick={() => add(product)}
                  disabled={!product.is_available || conflict}
                  aria-disabled={!product.is_available || conflict}
                  className={`product ${product.is_available ? "" : "unavailable"}`}
                  key={product.id}
                >
                  <b>{product.name}</b>
                  <span>{Number(product.price).toFixed(2)} €</span>
                  {/* SALE-07: visible, not just a disabled/greyed-out
                      button with no explanation — "produits indisponibles
                      visibles mais non ajoutables" is the whole point, not
                      "hidden". */}
                  {!product.is_available && <small className="unavailable-badge">Rupture</small>}
                </button>
              ))}
          </div>
        )}
      </AsyncSection>
      <div className="ticket">
        <h2>Articles sélectionnés</h2>
        {ticket.items.length === 0 ? (
          <p className="stock-meta">Touchez un article pour l&apos;ajouter.</p>
        ) : (
          ticket.items.map((item) => (
            <div className="ticket-line" key={item.id}>
              <div>
                <b>{item.product_name}</b>
                {!item.is_available && <small className="unavailable-badge">Rupture</small>}
                <div className="quantity">
                  <button
                    onClick={() => delta(item.product_id, -1)}
                    disabled={conflict}
                    aria-label={`Retirer un ${item.product_name}`}
                  >
                    <Minus size={14} />
                  </button>
                  <span aria-live="polite">{item.quantity}</span>
                  <button
                    onClick={() => delta(item.product_id, 1)}
                    disabled={conflict}
                    aria-label={`Ajouter un ${item.product_name}`}
                  >
                    <Plus size={14} />
                  </button>
                </div>
              </div>
              <b>{(Number(item.unit_price) * item.quantity).toFixed(2)} €</b>
            </div>
          ))
        )}
        <div className="ticket-total">
          <span>Total</span>
          <span>
            {total.toFixed(2)} €{syncing ? " · enregistrement…" : ""}
          </span>
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
      {payment === "Mixte" && (
        <div className="split-amounts">
          <TextField
            label="Espèces (€)"
            inputMode="decimal"
            type="number"
            min="0.01"
            step="0.01"
            value={cashSplit}
            onChange={(event) => setCashSplit(event.target.value)}
            placeholder="Ex. 10,00"
          />
          <TextField
            label="Carte (€)"
            inputMode="decimal"
            type="number"
            min="0.01"
            step="0.01"
            value={cardSplit}
            onChange={(event) => setCardSplit(event.target.value)}
            placeholder="Ex. 5,00"
          />
        </div>
      )}
      {error && (
        // SALE-08/ORD-05: an uncertain outcome and a version conflict are
        // both "something to check", not "fix your input" — visually
        // distinct from a definitive rejection so the copy matches the
        // action actually being asked for.
        <p className={uncertain || conflict ? "form-warning" : "form-error"} role="alert">
          {error}
        </p>
      )}
      {conflict ? (
        <button
          onClick={reload}
          disabled={syncing}
          className="primary-button"
          style={{ width: "100%", marginTop: 12 }}
        >
          {syncing ? "Rechargement…" : "Recharger le ticket"}
        </button>
      ) : cancelling ? (
        <div className="cancel-ticket">
          <TextField
            label="Motif de l'annulation"
            value={cancelReason}
            onChange={(event) => setCancelReason(event.target.value)}
            placeholder="Ex. Client parti sans commander"
            autoFocus
            required
          />
          <div className="cancel-actions">
            <button
              onClick={() => {
                setCancelling(false);
                setCancelReason("");
                setError("");
              }}
              disabled={saving}
            >
              Revenir au ticket
            </button>
            <button onClick={confirmCancel} disabled={saving} className="danger-button">
              {saving ? "Annulation…" : "Confirmer l'annulation"}
            </button>
          </div>
        </div>
      ) : (
        <button
          disabled={ticket.items.length === 0 || saving || syncing}
          onClick={checkout}
          className="primary-button"
          style={{
            width: "100%",
            marginTop: 12,
            opacity: ticket.items.length ? 1 : 0.45,
          }}
        >
          {saving
            ? "Encaissement…"
            : uncertain
              ? `Vérifier le paiement · ${total.toFixed(2)} €`
              : `Encaisser · ${total.toFixed(2)} €`}
        </button>
      )}
      {!conflict && !cancelling && (
        // ORD-06: always available, including on an empty ticket — an
        // abandoned counter sale with no lines still needs a way to be
        // closed, or it stays open forever with no screen showing it.
        <button
          onClick={() => setCancelling(true)}
          disabled={saving || syncing}
          className="link-button"
          style={{ width: "100%", marginTop: 8 }}
        >
          Annuler le ticket
        </button>
      )}
    </Dialog>
  );
}
