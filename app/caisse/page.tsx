"use client";

import { CalendarPlus, Plus, Table2 } from "lucide-react";
import { useState } from "react";
import { CashMovementModal } from "@/components/cash-movement-modal";
import { CloseDayModal } from "@/components/close-day-modal";
import { OrderDrawer } from "@/components/order-drawer";
import { AsyncSection } from "@/components/ui/async-section";
import { Shell } from "@/components/shell";
import { apiFetch } from "@/lib/client/api";
import { useAsyncData } from "@/lib/client/use-async-data";

interface DiningTable {
  id: number;
  name: string;
  status: "FREE" | "OCCUPIED";
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

  const [selected, setSelected] = useState<{ id: number | null; name: string } | null>(null);
  const [notice, setNotice] = useState("");
  const [movementOpen, setMovementOpen] = useState(false);
  const [closeOpen, setCloseOpen] = useState(false);
  const [now] = useState(() => new Date());

  function message(text: string) {
    setNotice(text);
    setTimeout(() => setNotice(""), 3500);
  }

  function done(total: number) {
    setSelected(null);
    tablesQuery.refetch();
    revenueQuery.refetch();
    cashQuery.refetch();
    message(`Vente encaissée (${total.toFixed(2)} €) : stock et tables mis à jour`);
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

  async function openTable(tableEntry: DiningTable) {
    setSelected({ id: tableEntry.id, name: tableEntry.name });
    if (tableEntry.status === "OCCUPIED") return;
    try {
      await apiFetch(`/api/tables/${tableEntry.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "OCCUPIED" }),
      });
      tablesQuery.refetch();
    } catch {
      // UX-01: a failed status change must not be silently ignored (it was,
      // pre-audit fix P0-05) — the drawer still opens (the cashier can keep
      // working), but they are told the floor plan may be out of sync.
      message("La table n'a pas pu être marquée occupée. Le plan de salle sera à vérifier.");
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
          onClick={() => setSelected({ id: null, name: "Vente directe" })}
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

      <div className="section-title">
        <div>
          <h2>Plan de salle</h2>
          <p className="eyebrow">Touchez une table pour prendre la commande</p>
        </div>
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
                key={tableEntry.id}
                className={`table-card ${tableEntry.status === "OCCUPIED" ? "occupied" : ""}`}
              >
                <Table2 className="table-icon" size={25} aria-hidden="true" />
                <span className={`pill ${tableEntry.status === "FREE" ? "free" : "busy"}`}>
                  {tableEntry.status === "FREE" ? "LIBRE" : "EN COURS"}
                </span>
                <h3>{tableEntry.name}</h3>
                <p>{tableEntry.status === "FREE" ? "Disponible" : "Occupée"}</p>
              </button>
            ))}
          </div>
        )}
      </AsyncSection>

      {selected && (
        <OrderDrawer
          table={selected.name}
          tableId={selected.id}
          onClose={() => setSelected(null)}
          onComplete={done}
        />
      )}
      {movementOpen && (
        <CashMovementModal onClose={() => setMovementOpen(false)} onSaved={movementSaved} />
      )}
      {closeOpen && <CloseDayModal onClose={() => setCloseOpen(false)} onFinished={newService} />}
    </Shell>
  );
}
