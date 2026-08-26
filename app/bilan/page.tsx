"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { AsyncSection } from "@/components/ui/async-section";
import { ContextBanner } from "@/components/context-banner";
import { Shell } from "@/components/shell";
import { ReceiptDialog } from "@/components/receipt-dialog";
import { StockRiskBlock } from "@/components/stock-risk-block";
import { apiFetch } from "@/lib/client/api";
import { useAsyncData } from "@/lib/client/use-async-data";
import { useCurrentUser } from "@/lib/client/use-current-user";
import {
  CASH_MOVEMENT_CATEGORY_LABELS,
  type CashMovementCategory,
} from "@/lib/validation/primitives";

interface DashboardStats {
  revenue: string;
  cash_revenue: string;
  card_revenue: string;
  orders_count: number;
  average_basket: string;
  /** CASH-04: null outside the open service — see lib/services/dashboard.ts. */
  expected_cash: string | null;
}

interface OrderRow {
  id: number;
  order_number: number;
  table_name: string | null;
  status: string;
  payment_method: string | null;
  total_amount: string;
  created_at: string;
  // ORD-01 renamed `closed_at`; a paid order carries `paid_at`, a cancelled
  // one `cancelled_at`. Reading the old name silently fell back to the
  // creation time on every row.
  paid_at: string | null;
  cancelled_at: string | null;
}

/** UX-06: the vocabulary DEC-03 fixed, shown rather than the raw enum. */
const ORDER_STATUS_LABELS: Record<string, string> = {
  PAID: "Encaissée",
  CANCELLED: "Annulée",
  REFUNDED: "Remboursée",
};

interface OrderHistoryPage {
  orders: OrderRow[];
  total: number;
  limit: number;
  offset: number;
}

const HISTORY_PAGE_SIZE = 8;

interface CashMovementRow {
  id: number;
  type: "OPENING" | "IN" | "OUT";
  /** CASH-03/DEC-11: the nature of the movement, next to its direction. */
  category: CashMovementCategory | "OPENING_FLOAT";
  amount: string;
  reason: string;
  created_at: string;
}

const MOVEMENT_CATEGORY_LABELS: Record<string, string> = {
  ...CASH_MOVEMENT_CATEGORY_LABELS,
  OPENING_FLOAT: "Fond de caisse",
};

const months = [
  "Janvier",
  "Février",
  "Mars",
  "Avril",
  "Mai",
  "Juin",
  "Juillet",
  "Août",
  "Septembre",
  "Octobre",
  "Novembre",
  "Décembre",
];

const PAYMENT_LABELS: Record<string, string> = { CASH: "Espèces", CARD: "CB", MIXED: "Mixte" };

/** BI-06: mirrors lib/services/alerts.ts::Alert — the client boundary keeps its own narrowed copy, same convention as every other interface in this file. */
interface AlertRow {
  type: string;
  severity: "critical" | "warning";
  message: string;
  actionLabel: string;
  actionHref: string;
}

export default function Bilan() {
  const now = useMemo(() => new Date(), []);
  const years = useMemo(() => [now.getFullYear(), now.getFullYear() - 1], [now]);

  const [receiptOrderId, setReceiptOrderId] = useState<number | null>(null);
  const [historyOffset, setHistoryOffset] = useState(0);
  const [historyStatus, setHistoryStatus] = useState<"" | "PAID" | "CANCELLED" | "REFUNDED">("");
  const user = useCurrentUser();
  // DEC-07: `orders:refund` is OWNER/MANAGER. A cashier still sees the
  // receipt — they hand it to the customer — but not the refund action.
  const canRefund = user?.role === "OWNER" || user?.role === "MANAGER";

  const [period, setPeriod] = useState<"Aujourd’hui" | "Ce mois" | "Cette année">("Aujourd’hui");
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());

  const periodKey = period === "Aujourd’hui" ? "day" : period === "Ce mois" ? "month" : "year";
  const statsQuery = useAsyncData(
    () =>
      apiFetch<DashboardStats>(`/api/dashboard?period=${periodKey}&month=${month}&year=${year}`),
    [periodKey, month, year],
  );
  // ORD-12: a real page of history, with its total, replacing the fixed
  // "fetch 100 and show the first 8" this screen used to do.
  const ordersQuery = useAsyncData(
    () =>
      apiFetch<OrderHistoryPage>(
        `/api/orders?limit=${HISTORY_PAGE_SIZE}&offset=${historyOffset}` +
          (historyStatus ? `&status=${historyStatus}` : ""),
      ),
    [historyOffset, historyStatus],
  );
  const movementsQuery = useAsyncData(() => apiFetch<CashMovementRow[]>("/api/cash-movements"), []);
  // BI-05: établissement et état du service, pour le bandeau de contexte —
  // pas de nouvelle logique, deux lectures déjà réelles ailleurs
  // (CFG-01 pour le nom, CASH-01 pour `businessDayOpen`).
  const settingsQuery = useAsyncData(() => apiFetch<{ name: string }>("/api/settings"), []);
  const cashSummaryQuery = useAsyncData(
    () => apiFetch<{ businessDayOpen: boolean }>("/api/cash-summary"),
    [],
  );
  const alertsQuery = useAsyncData(() => apiFetch<AlertRow[]>("/api/alerts"), []);

  // BI-05: "dernière synchronisation" — l'instant où l'un des trois widgets
  // du Bilan a le plus récemment reçu des données fraîches du serveur, pas
  // un chronomètre décoratif. Se met à jour à chaque succès, y compris un
  // rafraîchissement déclenché par un remboursement (onRefunded plus bas).
  // Même schéma que use-async-data.ts lui-même (setState conditionnel en
  // phase de rendu plutôt que dans un effet, qui provoquerait un rendu en
  // cascade) : comparer une signature des trois statuts à sa valeur suivie,
  // et ne poser l'horodatage que lorsqu'elle change vers un succès.
  const syncSignature = [
    statsQuery.state.status,
    ordersQuery.state.status,
    movementsQuery.state.status,
  ].join(",");
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);
  const [trackedSyncSignature, setTrackedSyncSignature] = useState(syncSignature);
  if (trackedSyncSignature !== syncSignature) {
    setTrackedSyncSignature(syncSignature);
    if (syncSignature.includes("success")) {
      setLastSyncedAt(new Date());
    }
  }

  const periodLabel =
    period === "Aujourd’hui"
      ? "Service en cours"
      : period === "Ce mois"
        ? `Mois : ${months[month - 1]} ${year}`
        : `Année : ${year}`;

  const eur = (value: string | number) => `${Number(value).toFixed(2).replace(".", ",")} €`;
  const dateFormatter = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" });

  return (
    <Shell>
      <div className="page-head">
        <div>
          <p className="eyebrow">Suivi de l&apos;activité</p>
          <h1>Le bilan</h1>
        </div>
      </div>

      <ContextBanner
        establishmentName={
          settingsQuery.state.status === "success" ? settingsQuery.state.data.name : null
        }
        periodLabel={periodLabel}
        serviceOpen={
          cashSummaryQuery.state.status === "success"
            ? cashSummaryQuery.state.data.businessDayOpen
            : null
        }
        lastSyncedAt={lastSyncedAt}
      />

      {/* BI-06: VISION_PRODUIT_ET_AUDIT.md §10's "Bloc À traiter maintenant" —
          period-independent on purpose, unlike everything below: an open
          ticket sitting for three hours matters whether the manager is
          currently looking at "Aujourd'hui" or "Cette année". */}
      <AsyncSection
        state={alertsQuery.state}
        onRetry={alertsQuery.refetch}
        isEmpty={(data) => data.length === 0}
        emptyMessage="Aucune alerte : rien à traiter pour le moment."
      >
        {(alerts) => (
          <div className="alerts-block">
            {alerts.map((alert) => (
              <Link
                key={alert.type}
                href={alert.actionHref}
                className={`alert-card ${alert.severity}`}
              >
                <span>{alert.message}</span>
                <span className="alert-action">{alert.actionLabel} →</span>
              </Link>
            ))}
          </div>
        )}
      </AsyncSection>

      <div className="segmented" role="tablist" aria-label="Période">
        {(["Aujourd’hui", "Ce mois", "Cette année"] as const).map((option) => (
          <button
            onClick={() => setPeriod(option)}
            key={option}
            role="tab"
            aria-selected={period === option}
            className={`segment ${period === option ? "active" : ""}`}
          >
            {option}
          </button>
        ))}
      </div>

      <div className="period-selects">
        <label>
          Mois
          <select
            value={month}
            onChange={(event) => {
              setMonth(Number(event.target.value));
              setPeriod("Ce mois");
            }}
            disabled={period !== "Ce mois"}
          >
            {months.map((label, index) => (
              <option value={index + 1} key={label}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Année
          <select
            value={year}
            onChange={(event) => setYear(Number(event.target.value))}
            disabled={period === "Aujourd’hui"}
          >
            {years.map((y) => (
              <option value={y} key={y}>
                {y}
              </option>
            ))}
          </select>
        </label>
      </div>

      <AsyncSection state={statsQuery.state} onRetry={statsQuery.refetch}>
        {(stats) => (
          <div className="kpis">
            <div className="kpi">
              <span className="kpi-label">Chiffre d&apos;affaires</span>
              <strong>{eur(stats.revenue)}</strong>
              <div className="split">Ventes encaissées</div>
            </div>
            <div className="kpi">
              <span className="kpi-label">Ventilation caisse</span>
              <strong>
                {eur(stats.cash_revenue)} / {eur(stats.card_revenue)}
              </strong>
              <div className="split">
                <span>
                  Espèces <b>{eur(stats.cash_revenue)}</b>
                </span>
                <span>
                  CB <b>{eur(stats.card_revenue)}</b>
                </span>
              </div>
            </div>
            {/* CASH-04: the same figure the caisse card and the closing use.
                Only shown for the open service — expected cash is a property
                of a session (DEC-04), so the API returns null over a month
                or a year rather than a total that reconciles against
                nothing. */}
            {stats.expected_cash !== null && (
              <div className="kpi">
                <span className="kpi-label">Espèces attendues</span>
                <strong>{eur(stats.expected_cash)}</strong>
                <div className="split">Fond + espèces + entrées − sorties</div>
              </div>
            )}
            <div className="kpi">
              <span className="kpi-label">Commandes</span>
              <strong>{stats.orders_count}</strong>
              <div className="split">Pour la période</div>
            </div>
            <div className="kpi">
              <span className="kpi-label">Panier moyen</span>
              <strong>{eur(stats.average_basket)}</strong>
              <div className="split">par commande</div>
            </div>
          </div>
        )}
      </AsyncSection>

      <div className="section-title">
        <div>
          <h2>Commandes récentes</h2>
          <p className="eyebrow">Dernières ventes de l&apos;établissement</p>
        </div>
      </div>
      <div className="segmented" role="tablist" aria-label="Filtrer par statut">
        {(
          [
            ["", "Toutes"],
            ["PAID", "Encaissées"],
            ["REFUNDED", "Remboursées"],
            ["CANCELLED", "Annulées"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={label}
            role="tab"
            aria-selected={historyStatus === value}
            className={historyStatus === value ? "active" : ""}
            onClick={() => {
              setHistoryStatus(value);
              // A filter change makes the current offset meaningless.
              setHistoryOffset(0);
            }}
          >
            {label}
          </button>
        ))}
      </div>

      <AsyncSection
        state={ordersQuery.state}
        onRetry={ordersQuery.refetch}
        isEmpty={(data) => data.total === 0}
        emptyMessage="Aucune commande encaissée pour le moment."
      >
        {(page) => (
          <div className="history-card">
            {page.orders.map((order) => (
              // ORD-09: the row opens the receipt. A history you cannot open
              // is a list of numbers with nothing behind them.
              <button
                type="button"
                className="order-row"
                key={order.id}
                onClick={() => setReceiptOrderId(order.id)}
              >
                <div>
                  <b>
                    #{order.order_number} · {order.table_name ?? "Vente directe"}
                  </b>
                  <small>
                    {dateFormatter.format(
                      new Date(order.paid_at ?? order.cancelled_at ?? order.created_at),
                    )}{" "}
                    · {order.payment_method ? PAYMENT_LABELS[order.payment_method] : "—"}
                    {order.status !== "PAID" &&
                      ` · ${ORDER_STATUS_LABELS[order.status] ?? order.status}`}
                  </small>
                </div>
                <strong>{eur(order.total_amount)}</strong>
              </button>
            ))}
            <div className="history-pager">
              <button
                type="button"
                disabled={historyOffset === 0}
                onClick={() => setHistoryOffset(Math.max(0, historyOffset - HISTORY_PAGE_SIZE))}
              >
                Précédentes
              </button>
              <small>
                {page.total === 0
                  ? "Aucune commande"
                  : `${page.offset + 1}–${Math.min(page.offset + page.limit, page.total)} sur ${page.total}`}
              </small>
              <button
                type="button"
                disabled={page.offset + page.limit >= page.total}
                onClick={() => setHistoryOffset(historyOffset + HISTORY_PAGE_SIZE)}
              >
                Suivantes
              </button>
            </div>
          </div>
        )}
      </AsyncSection>

      {/* BI-10: sits between "Commandes récentes" and "Journal de caisse" —
          both those sections rely on their own row/card being the first
          ".order-row" and the last ".history-card" on the page
          (bilan-real-data.spec.ts and friends), classes this block reuses
          for its own rows. Between the two is the one spot that disturbs
          neither. */}
      <StockRiskBlock />

      <div className="section-title">
        <div>
          <h2>Journal de caisse</h2>
          {/* CASH-07: the open service's journal, not the establishment's
              recent history — it has to describe the same period as the
              balance it sits under (DEC-04). */}
          <p className="eyebrow">Mouvements du service en cours</p>
        </div>
      </div>
      <AsyncSection
        state={movementsQuery.state}
        onRetry={movementsQuery.refetch}
        isEmpty={(data) => data.length === 0}
        emptyMessage="Aucun mouvement de caisse enregistré."
      >
        {(movements) => (
          <div className="history-card">
            {movements.slice(0, 8).map((movement) => (
              <div className="movement" key={movement.id}>
                <div>
                  <b>{movement.reason}</b>
                  <small>
                    {dateFormatter.format(new Date(movement.created_at))} ·{" "}
                    {MOVEMENT_CATEGORY_LABELS[movement.category] ??
                      (movement.type === "IN" ? "Entrée" : "Sortie")}
                  </small>
                </div>
                <b className={movement.type === "OUT" ? "out" : "in"}>
                  {movement.type === "OUT" ? "−" : "+"}
                  {eur(movement.amount)}
                </b>
              </div>
            ))}
          </div>
        )}
      </AsyncSection>

      {receiptOrderId !== null && (
        <ReceiptDialog
          orderId={receiptOrderId}
          canRefund={canRefund}
          onClose={() => setReceiptOrderId(null)}
          onRefunded={() => {
            setReceiptOrderId(null);
            // A refund changes net revenue, expected cash and the order's
            // own status — refetch rather than leave three stale figures.
            statsQuery.refetch();
            ordersQuery.refetch();
            movementsQuery.refetch();
          }}
        />
      )}
    </Shell>
  );
}
