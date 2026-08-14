import { z } from "zod";
import { ROLES, type Role } from "../authz";
import { toCents } from "../money";
import type { CashMovementType } from "../repositories/cash-movements";

/**
 * API-01: the reusable building blocks every request schema is assembled
 * from. One definition per business rule, so "what is a valid quantity" or
 * "what is a valid amount" is answered in exactly one place instead of being
 * re-improvised in each route handler (the state this replaces: an inline
 * `body.type !== "IN" && body.type !== "OUT"` in one file, a
 * `Number.isInteger` loop in another, and no check at all on product prices).
 *
 * Everything here is pure: no I/O, no database access. That is what makes
 * API-01's acceptance criterion — "toute entrée invalide retourne une erreur
 * métier stable *avant* l'accès base" — structurally true rather than a
 * convention someone has to remember.
 */

/** `SERIAL` primary keys are 32-bit; anything larger is not an id we ever issued. */
const MAX_ID = 2_147_483_647;

export const idSchema = z
  .number({ error: "Identifiant invalide." })
  .int({ error: "Identifiant invalide." })
  .positive({ error: "Identifiant invalide." })
  .max(MAX_ID, { error: "Identifiant invalide." });

/**
 * Dynamic route segments arrive as strings (`/api/products/42`). The regex
 * runs before the numeric coercion so `"4e2"`, `"0x1f"` and `" 42 "` are
 * rejected outright rather than quietly becoming 400, 31 and 42.
 */
export const idParamSchema = z
  .string({ error: "Identifiant invalide." })
  .regex(/^\d+$/, { error: "Identifiant invalide." })
  .transform(Number)
  .pipe(idSchema);

/**
 * An upper bound is not bureaucracy: without it a single line of `quantity:
 * 1e9` overflows the stock arithmetic and the order total long before any
 * business rule notices.
 */
export const MAX_QUANTITY = 9_999;

export const quantitySchema = z
  .number({ error: "Quantité invalide." })
  .int({ error: "La quantité doit être un nombre entier." })
  .min(1, { error: "La quantité doit être au moins de 1." })
  .max(MAX_QUANTITY, { error: `La quantité ne peut pas dépasser ${MAX_QUANTITY}.` });

/** Absolute stock counts differ from order quantities: 0 is a legitimate value ("rupture"). */
export const stockQuantitySchema = z
  .number({ error: "Quantité invalide." })
  .int({ error: "La quantité doit être un nombre entier." })
  .min(0, { error: "La quantité ne peut pas être négative." })
  .max(1_000_000, { error: "Quantité invalide." });

/**
 * Money on the wire: at most 2 decimals, never negative, within
 * `DECIMAL(10,2)`. The 2-decimal rule is not a stylistic preference — it is
 * `DEC-05` verbatim ("un produit à 4,995 € est refusé à la saisie ; `API-01`
 * impose 2 décimales exactes"). Silently rounding 4.995 would mean the price
 * displayed to the customer and the price charged could differ by a centime.
 *
 * Accepts a JSON number or a decimal string, and always **outputs integer
 * cents**, because that is the only representation in which the `DEC-05`
 * invariant `cash + card = total` can be checked without floating-point
 * drift. Call sites convert back with `fromCents()` at the database
 * boundary.
 */
const MONEY_PATTERN = /^\d{1,8}(\.\d{1,2})?$/;

const MONEY_MESSAGE = "Montant invalide : au maximum 2 décimales, sans signe négatif.";

function moneyTextOrNull(raw: number | string): string | null {
  if (typeof raw === "number") {
    // String(1e21) is "1e+21", String(NaN) is "NaN": both fail the pattern
    // below, which is the intent — they are not amounts a cash register
    // should ever accept.
    if (!Number.isFinite(raw)) return null;
    const text = String(raw);
    return MONEY_PATTERN.test(text) ? text : null;
  }
  const text = raw.trim();
  return MONEY_PATTERN.test(text) ? text : null;
}

export const moneyAmountSchema = z
  .union([z.number(), z.string()], { error: MONEY_MESSAGE })
  .superRefine((raw, ctx) => {
    if (moneyTextOrNull(raw) === null) {
      ctx.addIssue({ code: "custom", message: MONEY_MESSAGE });
    }
  })
  // Only reached when the refinement above passed, so the non-null assertion
  // is a fact of the pipeline, not an assumption.
  .transform((raw) => toCents(moneyTextOrNull(raw)!));

/**
 * Tax and discount rates (`DEC-05`), matching `DECIMAL(5,2)` in
 * `location_settings.default_tax_rate` and `tax_classes.rate`. The decimal
 * bound is checked on the textual form for the same reason as money:
 * `10.1 * 100` is `1009.9999999999999` in binary floating point, so any
 * arithmetic test would reject a perfectly valid rate.
 */
const PERCENT_PATTERN = /^\d{1,3}(\.\d{1,2})?$/;

export const percentSchema = z
  .number({ error: "Taux invalide." })
  .refine((value) => Number.isFinite(value) && PERCENT_PATTERN.test(String(value)), {
    error: "Taux invalide : au maximum 2 décimales, sans signe négatif.",
  })
  .refine((value) => value <= 100, { error: "Le taux ne peut pas dépasser 100 %." });

/** Trimmed, non-empty, length-bounded free text (names, labels). */
export function shortTextSchema(maxLength: number, label: string) {
  return z
    .string({ error: `${label} est requis.` })
    .trim()
    .min(1, { error: `${label} est requis.` })
    .max(maxLength, { error: `${label} ne peut pas dépasser ${maxLength} caractères.` });
}

/** `cash_movements.reason` is `VARCHAR(255)`; a longer motive would be truncated by Postgres. */
export const reasonSchema = shortTextSchema(255, "Le motif");

export const noteSchema = z
  .string()
  .trim()
  .max(500, { error: "La note ne peut pas dépasser 500 caractères." });

export const emailSchema = z
  .string({ error: "L'adresse e-mail est requise." })
  .trim()
  .min(1, { error: "L'adresse e-mail est requise." })
  .pipe(z.email({ error: "Adresse e-mail invalide." }));

export const paginationSchema = z.object({
  limit: z.coerce
    .number({ error: "Limite invalide." })
    .int({ error: "Limite invalide." })
    .min(1, { error: "Limite invalide." })
    .max(200, { error: "La limite ne peut pas dépasser 200." })
    .default(50),
  offset: z.coerce
    .number({ error: "Décalage invalide." })
    .int({ error: "Décalage invalide." })
    .min(0, { error: "Décalage invalide." })
    .default(0),
});

/** Reporting periods (`DEC-09`). An inverted range is a caller bug, not an empty result set. */
export const dateRangeSchema = z
  .object({
    from: z.iso.datetime({ offset: true, error: "Date de début invalide." }),
    to: z.iso.datetime({ offset: true, error: "Date de fin invalide." }),
  })
  .refine(({ from, to }) => new Date(from) <= new Date(to), {
    error: "La date de début doit précéder la date de fin.",
    path: ["from"],
  });

/*
 * Enums. Each value list is tied to the type it must mirror with `satisfies`,
 * so widening the TypeScript union without extending the schema is a compile
 * error rather than a runtime hole. The imports above are type-only: this
 * module stays free of any database dependency.
 */

export const PAYMENT_METHODS = ["CASH", "CARD", "MIXED"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export const paymentMethodSchema = z.enum(PAYMENT_METHODS, {
  error: 'Moyen de paiement invalide (attendu "CASH", "CARD" ou "MIXED").',
});

export const CASH_MOVEMENT_TYPES = ["IN", "OUT"] as const satisfies readonly Exclude<
  CashMovementType,
  "OPENING"
>[];
export const cashMovementTypeSchema = z.enum(CASH_MOVEMENT_TYPES, {
  error: 'Type de mouvement invalide (attendu "IN" ou "OUT").',
});

/**
 * CASH-03/DEC-11: the business nature of a movement, next to the `type` that
 * carries its sign. Declared per type rather than as one flat enum because a
 * category is only meaningful for one direction — an
 * `END_OF_SERVICE_WITHDRAWAL` that adds money to the till is not a typo to
 * tolerate, it is a corrupt ledger — and because the modal renders exactly
 * this list for the type currently selected. `migrations/0016` enforces the
 * same pairing in the database, which has writers other than this schema.
 *
 * `OPENING_FLOAT` is absent on purpose: `CASH_MOVEMENT_TYPES` already keeps
 * `OPENING` out of what a client may send, so the opening float stays
 * something only the business-day service (CASH-02) can record.
 */
export type ClientCashMovementType = (typeof CASH_MOVEMENT_TYPES)[number];

export const CASH_MOVEMENT_CATEGORIES_BY_TYPE = {
  IN: ["FUND_TOPUP", "OTHER"],
  OUT: ["END_OF_SERVICE_WITHDRAWAL", "PURCHASE", "BANK_DEPOSIT", "OTHER"],
} as const satisfies Record<ClientCashMovementType, readonly string[]>;

export const CASH_MOVEMENT_CATEGORIES = [
  "FUND_TOPUP",
  "END_OF_SERVICE_WITHDRAWAL",
  "PURCHASE",
  "BANK_DEPOSIT",
  "OTHER",
] as const;
export type CashMovementCategory = (typeof CASH_MOVEMENT_CATEGORIES)[number];
export const cashMovementCategorySchema = z.enum(CASH_MOVEMENT_CATEGORIES, {
  error: "Catégorie de mouvement invalide.",
});

/** French labels, shared by the movement modal and the cash journal (CASH-07). */
export const CASH_MOVEMENT_CATEGORY_LABELS: Record<CashMovementCategory, string> = {
  FUND_TOPUP: "Apport de monnaie",
  END_OF_SERVICE_WITHDRAWAL: "Retrait de fin de service",
  PURCHASE: "Achat ou dépense",
  BANK_DEPOSIT: "Dépôt en banque",
  OTHER: "Autre",
};

// A dining-table status enum used to live here. ORD-03 removed the stored
// column entirely — occupancy is derived from the table's open ticket — so
// there is no such value for a client to send any more, and validating one
// would only keep alive an input the API no longer accepts.

export const roleSchema = z.enum(ROLES as readonly [Role, ...Role[]], {
  error: "Rôle invalide.",
});

export const DASHBOARD_PERIODS = ["day", "month", "year"] as const;
export type DashboardPeriodValue = (typeof DASHBOARD_PERIODS)[number];
export const dashboardPeriodSchema = z.enum(DASHBOARD_PERIODS, {
  error: 'Période invalide (attendu "day", "month" ou "year").',
});
