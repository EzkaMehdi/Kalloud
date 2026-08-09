"use client";

import { CalendarPlus, Plus, Table2 } from "lucide-react";
import { useState } from "react";
import { CashMovementModal } from "@/components/cash-movement-modal";
import { CloseDayModal } from "@/components/close-day-modal";
import { OrderDrawer, type Ticket } from "@/components/order-drawer";
import { AsyncSection } from "@/components/ui/async-section";
import { Shell } from "@/components/shell";
import { ApiError, apiFetch } from "@/lib/client/api";
import { useAsyncData } from "@/lib/client/use-async-data";

/**
 * ORD-03: occupancy is derived server-side from the table's open ticket —
 * there is no stored status to read any more, and no local guess to keep in
 * sync with it.
 */
interface DiningTable {
  id: number;
  name: string;
  open_order_id: number | null;
  is_occupied: boolean;
  open_order_total: string | null;
}

interface CashSummary {
  balance: string;
}

interface DashboardSummary {
  revenue: string;
}

export default function Caisse() {
  const tablesQuery = useAsyncData(() => apiFetch<DiningTable[]>("/api/tables"), []);
  const cashQuery = useAsyncData(() => apiFetch<CashSummary>("/api/cash-summary"), []);
  const revenueQuery = useAsyncData(
    () => apiFetch<DashboardSummary>("/api/dashboard?period=day"),
    [],
  );
  // ORD-07: counter tickets belong to no table, so nothing on the floor plan
  // would surface them. Without this list they would be unreachable the
  // moment the drawer closes.
  const counterQuery = useAsyncData(
    () => apiFetch<{ id: number; order_number: number; total_amount: string }[]>("/api/tickets"),
    [],
  );

  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [opening, setOpening] = useState(false);
  const [notice, setNotice] = useState("");
  const [movementOpen, setMovementOpen] = useState(false);
  const [closeOpen, setCloseOpen] = useState(false);
  const [now] = useState(() => new Date());

  function message(text: string) {
    setNotice(text);
    setTimeout(() => setNotice(""), 3500);
  }

  function done(total: number, replayed?: boolean) {
    setTicket(null);
    counterQuery.refetch();
    tablesQuery.refetch();
    revenueQuery.refetch();
    cashQuery.refetch();
    // SALE-08/DEC-08: a retry that recovered an already-recorded sale
    // (network failure, response lost, same idempotency key) is told apart
    // from a fresh sale — same underlying refresh, different notice, so a
    // cashier who just retried isn't left assuming they made two sales.
    message(
      replayed
        ? `Vente déjà enregistrée retrouvée (${total.toFixed(2)} €) : aucun doublon créé, stock et tables mis à jour`
        : `Vente encaissée (${total.toFixed(2)} €) : stock et tables mis à jour`,
    );
  }

  function movementSaved(_amount: number, _type: "IN" | "OUT") {
    cashQuery.refetch();
    message("Mouvement enregistré dans le journal de caisse");
  }

  function newService() {
    cashQuery.refetch();
    revenueQuery.refetch();
    tablesQuery.refetch();
    message("Service clôturé : un nouveau service est ouvert");
  }

  /**
   * ORD-04: opening a table means opening (or resuming) its ticket
   * server-side, and only then showing the drawer.
   *
   * The optimistic `PATCH {status: "OCCUPIED"}` this replaces marked the
   * table busy before any order existed, and had no rollback — an abandoned
   * order left it occupied with nothing to reconcile against (ORD-03). Now
   * the ticket *is* the occupancy, so there is nothing to undo: if this call
   * fails, no ticket was created and the table was never marked.
   */
  async function openTable(tableEntry: DiningTable) {
    await openTicket({ tableId: tableEntry.id }, tableEntry.is_occupied);
  }

  /** ORD-07: reopens an existing counter ticket by id, the same drawer a table gets. */
  async function resumeTicket(orderId: number) {
    if (opening) return;
    setOpening(true);
    try {
      setTicket(await apiFetch<Ticket>(`/api/tickets/${orderId}`));
    } catch (caught) {
      message(caught instanceof ApiError ? caught.message : "Impossible de reprendre ce ticket.");
    } finally {
      setOpening(false);
    }
  }

  async function openTicket(body: { tableId: number | null }, resuming = false) {
    if (opening) return;
    setOpening(true);
    try {
      const opened = await apiFetch<{ ticket: Ticket; created: boolean }>("/api/tickets", {
        method: "POST",
        body: JSON.stringify(body),
      });
      setTicket(opened.ticket);
      tablesQuery.refetch();
      counterQuery.refetch();
      if (!opened.created || resuming) {
        message(`Ticket #${opened.ticket.order_number} repris`);
      }
    } catch (caught) {
      // UX-01: no drawer on a failure. Opening one over a ticket that does
      // not exist is exactly the "mock silencieux" the audit flagged — the
      // cashier would type a round into nothing.
      message(
        caught instanceof ApiError
          ? caught.message
          : "Impossible d'ouvrir le ticket. Réessayez dans un instant.",
      );
    } finally {
      setOpening(false);
    }
  }

  return (
    <Shell>
      <div className="page-head">
        <div>
          <p className="eyebrow">
            {new Intl.DateTimeFormat("fr-FR", {
              weekday: "long",
              day: "numeric",
              month: "long",
              hour: "2-digit",
              minute: "2-digit",
            }).format(now)}
          </p>
          <h1>La caisse</h1>
        </div>
        <button
          onClick={() => openTicket({ tableId: null })}
          disabled={opening}
          className="icon-button"
          aria-label="Vente directe"
        >
          <Plus size={22} />
        </button>
      </div>

      {notice && (
        <div className="status" style={{ marginBottom: 12 }} role="status" aria-live="polite">
          <span className="dot" aria-hidden="true" />
          {notice}
        </div>
      )}

      <div className="cash-card">
        <div>
          <small>Espèces en caisse</small>
          <strong>
            {cashQuery.state.status === "success"
              ? `${Number(cashQuery.state.data.balance).toFixed(2).replace(".", ",")} €`
              : cashQuery.state.status === "error"
                ? "—"
                : "…"}
          </strong>
        </div>
        <button onClick={() => setMovementOpen(true)}>Mouvement</button>
      </div>
      {cashQuery.state.status === "error" && (
        <p className="form-error" role="alert" style={{ marginTop: -18, marginBottom: 18 }}>
          {cashQuery.state.message}
        </p>
      )}

      <div className="quick-kpi">
        <span>Chiffre d&apos;affaires du service</span>
        <b>
          {revenueQuery.state.status === "success"
            ? `${Number(revenueQuery.state.data.revenue).toFixed(2).replace(".", ",")} €`
            : revenueQuery.state.status === "error"
              ? "—"
              : "…"}
        </b>
        <small>Un service se clôture manuellement</small>
      </div>

      <button className="close-day-button" onClick={() => setCloseOpen(true)}>
        <CalendarPlus size={18} aria-hidden="true" />
        <span>
          <b>Clôturer le service</b>
          <small>Compter la caisse, figer le bilan et repartir sur un nouveau service</small>
        </span>
      </button>

      {counterQuery.state.status === "success" && counterQuery.state.data.length > 0 && (
        <>
          <div className="section-title">
            <div>
              <h2>Ventes directes en cours</h2>
              <p className="eyebrow">Tickets au comptoir, sans table</p>
            </div>
          </div>
          <div className="tables">
            {counterQuery.state.data.map((counterTicket) => (
              <button
                key={counterTicket.id}
                disabled={opening}
                onClick={() => resumeTicket(counterTicket.id)}
                className="table-card occupied"
              >
                <Table2 className="table-icon" size={25} aria-hidden="true" />
                <span className="pill busy">EN COURS</span>
                <h3>Ticket #{counterTicket.order_number}</h3>
                <p>{Number(counterTicket.total_amount).toFixed(2).replace(".", ",")} €</p>
              </button>
            ))}
          </div>
        </>
      )}

      <div className="section-title">
        <div>
          <h2>Plan de salle</h2>
          <p className="eyebrow">Touchez une table pour prendre la commande</p>
        </div>
        {/* TODO(CASH-02/CASH-07): hardcoded regardless of the real business
            day state — GET /api/cash-summary now exposes `businessDayOpen`
            (CASH-01) precisely so this can stop lying once the caisse
            screen's open/close flow is wired to it. */}
        <span className="status">
          <span className="dot" aria-hidden="true" />
          Service ouvert
        </span>
      </div>

      <AsyncSection
        state={tablesQuery.state}
        onRetry={tablesQuery.refetch}
        isEmpty={(data) => data.length === 0}
        emptyMessage="Aucune table configurée pour cet établissement."
      >
        {(tables) => (
          <div className="tables">
            {tables.map((tableEntry) => (
              <button
                onClick={() => openTable(tableEntry)}
                disabled={opening}
                key={tableEntry.id}
                className={`table-card ${tableEntry.is_occupied ? "occupied" : ""}`}
              >
                <Table2 className="table-icon" size={25} aria-hidden="true" />
                <span className={`pill ${tableEntry.is_occupied ? "busy" : "free"}`}>
                  {tableEntry.is_occupied ? "EN COURS" : "LIBRE"}
                </span>
                <h3>{tableEntry.name}</h3>
                {/* The running total comes from the open ticket itself, so a
                    table can never show an amount it has no order for. */}
                <p>
                  {tableEntry.is_occupied
                    ? `${Number(tableEntry.open_order_total ?? 0)
                        .toFixed(2)
                        .replace(".", ",")} €`
                    : "Disponible"}
                </p>
              </button>
            ))}
          </div>
        )}
      </AsyncSection>

      {ticket && (
        <OrderDrawer
          ticket={ticket}
          onClose={() => {
            setTicket(null);
            // A ticket left open keeps its table busy, and a counter one
            // keeps its running total — refetch both so the screen says so
            // immediately rather than at the next navigation. Missing the
            // counter list here showed an abandoned ticket at 0,00 € even
            // after lines had been added to it.
            tablesQuery.refetch();
            counterQuery.refetch();
          }}
          onComplete={done}
          onCancelled={() => {
            setTicket(null);
            tablesQuery.refetch();
            counterQuery.refetch();
            message("Ticket annulé : rien n'a été encaissé");
          }}
        />
      )}
      {movementOpen && (
        <CashMovementModal onClose={() => setMovementOpen(false)} onSaved={movementSaved} />
      )}
      {closeOpen && <CloseDayModal onClose={() => setCloseOpen(false)} onFinished={newService} />}
    </Shell>
  );
}
