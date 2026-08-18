/**
 * BI-01: the canonical KPI dictionary DEC-09 asks for, made a literal
 * artifact of the code rather than a table living only in that document. A
 * cockpit built from `lib/services/metrics.ts` cannot silently redefine
 * "chiffre d'affaires" one screen at a time — every consumer resolves the
 * same handful of ids against this one registry.
 *
 * `version` exists for the day a formula's *meaning* changes (not a bug fix
 * — an actual redefinition, e.g. deciding tips count towards net revenue).
 * Bumping it here is how a consumer — an export, a screenshot, a support
 * ticket — can tell "this figure was computed under a different rule" from
 * "this figure is simply wrong". Nothing bumps it yet; every definition
 * below is DEC-09's dictionary, unmodified.
 */

export type MetricId =
  | "net_revenue"
  | "orders_count"
  | "average_basket"
  | "expected_cash"
  | "cash_variance"
  | "stock_out_of_stock"
  | "stock_low_stock";

export interface MetricDefinition {
  readonly id: MetricId;
  readonly version: 1;
  readonly label: string;
  /** Human-readable, mirrors DEC-09's "Formule" column verbatim. */
  readonly formula: string;
  /** Tables the value is read from — DEC-09's "Source" column. */
  readonly source: readonly string[];
}

export const METRIC_DICTIONARY: Readonly<Record<MetricId, MetricDefinition>> = {
  net_revenue: {
    id: "net_revenue",
    version: 1,
    label: "Chiffre d'affaires net",
    formula: "SUM(commandes PAID.total) − SUM(remboursements)",
    source: ["orders", "payments"],
  },
  orders_count: {
    id: "orders_count",
    version: 1,
    label: "Nombre de commandes",
    formula: "COUNT(commandes PAID non annulées)",
    source: ["orders"],
  },
  average_basket: {
    id: "average_basket",
    version: 1,
    label: "Panier moyen",
    formula: "CA net / nombre de commandes",
    source: ["orders", "payments"],
  },
  expected_cash: {
    id: "expected_cash",
    version: 1,
    label: "Espèces attendues",
    formula: "fond initial + ventes espèces nettes + entrées − sorties",
    source: ["business_days", "cash_movements", "payments"],
  },
  cash_variance: {
    id: "cash_variance",
    version: 1,
    label: "Écart de caisse",
    formula: "espèces comptées − espèces attendues",
    source: ["business_days"],
  },
  stock_out_of_stock: {
    id: "stock_out_of_stock",
    version: 1,
    label: "Produits en rupture",
    formula: "COUNT(produits actifs avec stock_quantity = 0)",
    source: ["products"],
  },
  stock_low_stock: {
    id: "stock_low_stock",
    version: 1,
    label: "Produits sous le seuil d'alerte",
    formula: "COUNT(produits actifs avec 0 < stock_quantity <= alert_threshold)",
    source: ["products"],
  },
};
