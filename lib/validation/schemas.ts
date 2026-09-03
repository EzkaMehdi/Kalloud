import { z } from "zod";
import {
  CASH_MOVEMENT_CATEGORIES_BY_TYPE,
  cashMovementCategorySchema,
  cashMovementTypeFilterSchema,
  cashMovementTypeSchema,
  dashboardPeriodSchema,
  emailSchema,
  idSchema,
  moneyAmountSchema,
  noteSchema,
  paymentLineMethodSchema,
  paymentMethodSchema,
  paymentTypeSchema,
  manualStockMovementTypeSchema,
  quantitySchema,
  STOCK_MOVEMENT_DIRECTION,
  stockDeltaSchema,
  stockMovementTypeFilterSchema,
  reasonSchema,
  shortTextSchema,
  stockQuantitySchema,
} from "./primitives";

/**
 * API-01: one schema per endpoint payload, assembled from ./primitives.
 * Each schema also exports its inferred type, and those types replace the
 * hand-written `interface CreateProductBody { name?: string }`-style
 * declarations that used to sit next to each route handler — where every
 * field was optional and nothing enforced it, so a missing field became an
 * empty string in the database instead of a 400.
 *
 * Objects are strict: an unrecognised key is rejected rather than ignored.
 * A client sending `{ cardAmout: 20 }` (typo) previously got a silent
 * zero-euro card payment; now it gets told.
 */

/* -------------------------------------------------------------------------- */
/* Authentication                                                             */
/* -------------------------------------------------------------------------- */

export const credentialsSchema = z.strictObject({
  email: emailSchema,
  password: z.string({ error: "Le mot de passe est requis." }).min(1, {
    error: "Le mot de passe est requis.",
  }),
});
export type Credentials = z.infer<typeof credentialsSchema>;

/**
 * SAAS-01: the shape of a new customer. Deliberately short — DEC-01 puts one
 * establishment per organization for the MVP, so the establishment's name is
 * the organization's too, and everything else (timezone, currency, tax rate,
 * threshold) has a default the owner refines afterwards through CFG-01.
 * Asking for it at signup would put a form between someone and the product
 * before they have seen it.
 *
 * The password is only bounded here; its strength is `assertPasswordStrength`
 * (the same rule the password reset applies), so one function stays the
 * authority on what a strong password is.
 */
export const signupSchema = z.strictObject({
  establishmentName: shortTextSchema(120, "Le nom de l'établissement"),
  ownerName: shortTextSchema(120, "Votre nom"),
  email: emailSchema,
  password: z
    .string({ error: "Le mot de passe est requis." })
    .min(1, { error: "Le mot de passe est requis." })
    .max(200, { error: "Mot de passe trop long." }),
});
export type SignupBody = z.infer<typeof signupSchema>;

export const passwordResetRequestSchema = z.strictObject({ email: emailSchema });
export type PasswordResetRequestBody = z.infer<typeof passwordResetRequestSchema>;

export const passwordResetConfirmSchema = z.strictObject({
  token: shortTextSchema(200, "Le jeton de réinitialisation"),
  // Strength is enforced by assertPasswordStrength() in lib/auth/password.ts,
  // which owns the policy; duplicating its rules here would let the two
  // definitions drift apart.
  password: z.string({ error: "Le mot de passe est requis." }).min(1, {
    error: "Le mot de passe est requis.",
  }),
});
export type PasswordResetConfirmBody = z.infer<typeof passwordResetConfirmSchema>;

/* -------------------------------------------------------------------------- */
/* Checkout                                                                   */
/* -------------------------------------------------------------------------- */

export const checkoutItemSchema = z.strictObject({
  productId: idSchema,
  quantity: quantitySchema,
  notes: noteSchema.nullish(),
});

/**
 * The cross-field rules are `DEC-05` verbatim: for `CASH` the card side must
 * be zero, for `CARD` the cash side must be zero, and `MIXED` means the user
 * actually split the payment, so both sides must be non-zero. The remaining
 * half of the rule — `cash + card = total TTC` — cannot live here, because
 * the total is only known once the server has priced the ticket from its own
 * catalog; it lands with the canonical checkout (`SALE-03`).
 *
 * Amounts come out of this schema as **integer cents** (`…AmountCents`), so
 * no downstream code has to wonder which unit it is holding.
 */
export const checkoutBodySchema = z
  .strictObject({
    /**
     * ORD-07: every sale names the ticket it settles. There is no second way
     * in any more — a counter sale opens a ticket exactly like a table does,
     * so "vente directe" is a ticket without a table rather than a parallel
     * journey with its own rules. That removes the conceptual duplicate the
     * task names, and with it the only path by which an order could reach
     * `PAID` without ever having been `OPEN`.
     *
     * The sale's contents always come from that ticket's persisted lines:
     * the database is the truth, not whatever the browser still had in
     * memory.
     */
    orderId: idSchema,
    paymentMethod: paymentMethodSchema,
    cashAmount: moneyAmountSchema.optional(),
    cardAmount: moneyAmountSchema.optional(),
  })
  .superRefine((body, ctx) => {
    const cash = body.cashAmount ?? 0;
    const card = body.cardAmount ?? 0;

    if (body.paymentMethod === "CASH" && card !== 0) {
      ctx.addIssue({
        code: "custom",
        path: ["cardAmount"],
        message: "Un paiement en espèces ne peut pas porter de montant carte.",
      });
    }
    if (body.paymentMethod === "CARD" && cash !== 0) {
      ctx.addIssue({
        code: "custom",
        path: ["cashAmount"],
        message: "Un paiement par carte ne peut pas porter de montant espèces.",
      });
    }
    if (body.paymentMethod === "MIXED" && (cash === 0 || card === 0)) {
      ctx.addIssue({
        code: "custom",
        path: ["cashAmount"],
        message:
          "Un paiement mixte exige un montant espèces et un montant carte, tous deux supérieurs à zéro.",
      });
    }
  })
  .transform(({ cashAmount, cardAmount, ...rest }) => ({
    ...rest,
    cashAmountCents: cashAmount ?? 0,
    cardAmountCents: cardAmount ?? 0,
  }));
export type CheckoutBody = z.infer<typeof checkoutBodySchema>;
export type CheckoutItem = z.infer<typeof checkoutItemSchema>;

/* -------------------------------------------------------------------------- */
/* Catalog                                                                    */
/* -------------------------------------------------------------------------- */

export const createProductSchema = z.strictObject({
  categoryId: idSchema.nullish(),
  /** CFG-02/DEC-05: a product's own class wins over its category's, which wins over the establishment default. */
  taxClassId: idSchema.nullish(),
  name: shortTextSchema(150, "Le nom du produit"),
  price: moneyAmountSchema,
  /** CFG-02: how the product is counted, so the stock screen can say "3 bouteilles". */
  unit: shortTextSchema(20, "L'unité").nullish(),
  stockQuantity: stockQuantitySchema.optional(),
  alertThreshold: stockQuantitySchema.optional(),
});
export type CreateProductBody = z.infer<typeof createProductSchema>;

export const updateProductSchema = z
  .strictObject({
    name: shortTextSchema(150, "Le nom du produit").optional(),
    price: moneyAmountSchema.optional(),
    categoryId: idSchema.nullish(),
    taxClassId: idSchema.nullish(),
    unit: shortTextSchema(20, "L'unité").nullish(),
    stockQuantity: stockQuantitySchema.optional(),
    alertThreshold: stockQuantitySchema.optional(),
    isActive: z.boolean({ error: "Statut d'activation invalide." }).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    error: "Indiquez au moins un champ à modifier.",
  });
export type UpdateProductBody = z.infer<typeof updateProductSchema>;

/**
 * STK-04: a stock change is a *delta*, never a total.
 *
 * `updateStockSchema` — `{ quantity }`, the new absolute balance — is gone
 * with the endpoint that took it. The screen computed that total as
 * `product.stock_quantity + amount` from whatever it had loaded, so a sale
 * settled in between was silently overwritten: the acceptance criterion
 * ("aucune mise à jour absolue depuis un état client périmé") is about
 * exactly that arithmetic. A delta carries no opinion about the balance it
 * lands on, so there is nothing stale to send.
 */
export const adjustStockSchema = z
  .strictObject({
    delta: stockDeltaSchema,
    type: manualStockMovementTypeSchema,
    reason: reasonSchema,
  })
  // The direction is part of what the type *means* (DEC-06): a RECEIPT that
  // removes units is not a receipt. `migrations/0007` enforces the same
  // pairing; this is the half the user can read.
  .refine(
    (body) =>
      STOCK_MOVEMENT_DIRECTION[body.type] === "either" ||
      (STOCK_MOVEMENT_DIRECTION[body.type] === "in" ? body.delta > 0 : body.delta < 0),
    {
      error: "Le sens de la quantité ne correspond pas au type de mouvement.",
      path: ["delta"],
    },
  );
export type AdjustStockBody = z.infer<typeof adjustStockSchema>;

/**
 * STK-07: a physical count states what is on the shelf, so it is an absolute
 * quantity — the one place an absolute number is the honest input, unlike
 * the adjustment above. Zero is legitimate (an empty shelf is a count), and
 * the note is optional: the écart the system computes is the justification,
 * and demanding a sentence for a count that matched would be asking someone
 * to explain that nothing was wrong.
 */
export const recordStockCountSchema = z.strictObject({
  countedQuantity: stockQuantitySchema,
  note: shortTextSchema(255, "La note").optional(),
});
export type RecordStockCountBody = z.infer<typeof recordStockCountSchema>;

/* -------------------------------------------------------------------------- */
/* Floor plan                                                                 */
/* -------------------------------------------------------------------------- */

export const createDiningTableSchema = z.strictObject({
  name: shortTextSchema(100, "Le nom de la table"),
});
export type CreateDiningTableBody = z.infer<typeof createDiningTableSchema>;

/**
 * ORD-03: `status` is gone. Occupancy is derived from the table's open
 * ticket (migration 0011 dropped the column), so the only thing left to
 * change about a table is its name — floor-plan configuration, not service
 * activity.
 */
export const updateDiningTableSchema = z
  .strictObject({
    name: shortTextSchema(100, "Le nom de la table").optional(),
    /** CFG-03: deactivating keeps the table's history but removes it from the floor plan. */
    isActive: z.boolean({ error: "Statut d'activation invalide." }).optional(),
  })
  .refine((body) => body.name !== undefined || body.isActive !== undefined, {
    error: "Indiquez au moins un champ à modifier (name ou isActive).",
  });
export type UpdateDiningTableBody = z.infer<typeof updateDiningTableSchema>;

/* -------------------------------------------------------------------------- */
/* Open tickets (ORD-02 / ORD-04 / ORD-05)                                     */
/* -------------------------------------------------------------------------- */

/**
 * Opening a ticket. `tableId: null` is a counter sale, which ORD-07 will
 * fold into the same journey as the table flow.
 */
export const openTicketSchema = z.strictObject({
  tableId: idSchema.nullish(),
});
export type OpenTicketBody = z.infer<typeof openTicketSchema>;

export const ticketItemSchema = z.strictObject({
  productId: idSchema,
  quantity: quantitySchema,
  notes: noteSchema.nullish(),
});

/**
 * Saving a ticket's contents. `version` is not optional and has no default:
 * ORD-05's guarantee is that a device writes against the state it actually
 * read, and a missing version would have to be interpreted as "whatever is
 * current", which is precisely the silent overwrite DEC-08 rules out.
 *
 * An empty `items` array is valid — emptying a ticket is a real action, and
 * refusing it would leave a cashier unable to undo their last line.
 */
export const saveTicketItemsSchema = z.strictObject({
  version: z
    .number({ error: "Version du ticket manquante." })
    .int({ error: "Version du ticket invalide." })
    .min(1, { error: "Version du ticket invalide." }),
  items: z
    .array(ticketItemSchema, { error: "Liste d'articles invalide." })
    .max(200, { error: "Un ticket ne peut pas dépasser 200 lignes." }),
  /**
   * ORD-08: the order's own note ("sans oignons", "table pressée"). Saved
   * with the lines and against the same version, because it is part of the
   * same ticket state — a separate endpoint would let two devices write a
   * note and a line list that never coexisted.
   *
   * `null` clears it, which is why this is nullish rather than optional:
   * "absent" and "emptied" are different intents.
   */
  notes: noteSchema.nullish(),
});
export type SaveTicketItemsBody = z.infer<typeof saveTicketItemsSchema>;

/**
 * ORD-06: a motive is required, not optional. "Aucune annulation
 * silencieuse" is the acceptance criterion, and an optional field defaulting
 * to empty would be exactly that with extra steps — the database refuses one
 * too (migration 0012).
 */
export const cancelTicketSchema = z.strictObject({
  reason: shortTextSchema(255, "Le motif d'annulation"),
});
export type CancelTicketBody = z.infer<typeof cancelTicketSchema>;

/* -------------------------------------------------------------------------- */
/* Cash                                                                       */
/* -------------------------------------------------------------------------- */

export const createCashMovementSchema = z
  .strictObject({
    type: cashMovementTypeSchema,
    category: cashMovementCategorySchema,
    amount: moneyAmountSchema,
    reason: reasonSchema,
  })
  .refine((body) => body.amount > 0, {
    error: "Le montant doit être supérieur à zéro.",
    path: ["amount"],
  })
  // CASH-03/DEC-11: a category only exists for one direction. Checked here so
  // the client gets a named field back (API-01) rather than the database's
  // constraint violation surfacing as an opaque 500 — `migrations/0016`
  // enforces the same rule for every other writer.
  .refine(
    (body) =>
      (CASH_MOVEMENT_CATEGORIES_BY_TYPE[body.type] as readonly string[]).includes(body.category),
    {
      error: "Cette catégorie ne correspond pas au sens du mouvement.",
      path: ["category"],
    },
  )
  .transform(({ amount, ...rest }) => ({ ...rest, amountCents: amount }));
export type CreateCashMovementBody = z.infer<typeof createCashMovementSchema>;

/**
 * CASH-05: closing is a reconciliation, so it carries the count.
 *
 * `countedCash` is required — "montant vide ou invalide refusé" is the
 * acceptance criterion, and a default of any kind would let a service close
 * on a number nobody counted. Zero is accepted: an emptied drawer is a real
 * answer, an unstated one is not.
 *
 * `nextOpeningCash` is the float deliberately left for tomorrow. It is
 * recorded and pre-fills the next opening; it does not open anything
 * (DEC-04/CASH-02). `varianceReason` becomes mandatory beyond the
 * establishment's threshold — enforced in the service, which is where the
 * threshold (CFG-00) and the computed variance both live.
 */
export const closeBusinessDaySchema = z
  .strictObject({
    countedCash: moneyAmountSchema,
    nextOpeningCash: moneyAmountSchema.optional(),
    varianceReason: reasonSchema.optional(),
  })
  .transform(({ countedCash, nextOpeningCash, varianceReason }) => ({
    countedCashCents: countedCash,
    nextOpeningCashCents: nextOpeningCash ?? null,
    varianceReason: varianceReason ?? null,
  }));
export type CloseBusinessDayBody = z.infer<typeof closeBusinessDaySchema>;

// CASH-02: the fund of a service is stated when that service is explicitly
// opened, never as a side effect of closing the previous one.
export const openBusinessDaySchema = z.strictObject({
  openingCash: moneyAmountSchema.optional(),
});
export type OpenBusinessDayBody = z.infer<typeof openBusinessDaySchema>;

/* -------------------------------------------------------------------------- */
/* Reporting                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Query strings are all-string, hence `z.coerce`. `year`/`month` are only
 * meaningful for the matching period, but the dashboard service already
 * treats them as hints; bounding them here stops `month=99` from reaching
 * the date arithmetic.
 */
export const dashboardQuerySchema = z.object({
  period: dashboardPeriodSchema.default("day"),
  year: z.coerce
    .number({ error: "Année invalide." })
    .int({ error: "Année invalide." })
    .min(2000, { error: "Année invalide." })
    .max(2100, { error: "Année invalide." })
    .optional(),
  month: z.coerce
    .number({ error: "Mois invalide." })
    .int({ error: "Mois invalide." })
    .min(1, { error: "Mois invalide." })
    .max(12, { error: "Mois invalide." })
    .optional(),
});
export type DashboardQuery = z.infer<typeof dashboardQuerySchema>;

/* -------------------------------------------------------------------------- */
/* Refunds (ORD-10)                                                            */
/* -------------------------------------------------------------------------- */

/**
 * ORD-10/DEC-05: a refund is "toujours associé à un motif", so the reason is
 * required here exactly as it is for a cancellation.
 *
 * `amount` is optional and means "everything still owed on this order" when
 * absent — the common case, and one the client should not have to compute
 * from figures the server already holds, at the risk of being a cent off.
 */
export const refundOrderSchema = z.strictObject({
  reason: shortTextSchema(255, "Le motif du remboursement"),
  amount: moneyAmountSchema.optional(),
});
export type RefundOrderBody = z.infer<typeof refundOrderSchema>;

/* -------------------------------------------------------------------------- */
/* Discounts (ORD-11)                                                          */
/* -------------------------------------------------------------------------- */

export const DISCOUNT_TYPES = ["FIXED", "PERCENT"] as const;
export const discountTypeSchema = z.enum(DISCOUNT_TYPES, {
  error: 'Type de remise invalide (attendu "FIXED" ou "PERCENT").',
});

/**
 * ORD-11/DEC-05: "montant fixe ou pourcentage, motif obligatoire". Setting
 * `discount: null` removes it, which is why the route body wraps it — an
 * absent field and a cleared discount are different intents, exactly as for
 * a ticket's note.
 */
export const discountSchema = z
  .strictObject({
    type: discountTypeSchema,
    value: moneyAmountSchema,
    reason: shortTextSchema(255, "Le motif de la remise"),
  })
  .superRefine((body, ctx) => {
    if (body.value <= 0) {
      ctx.addIssue({
        code: "custom",
        path: ["value"],
        message: "La remise doit être supérieure à zéro.",
      });
    }
    // A percentage arrives in cents like every other money value (10 % is
    // 1000), so 100 % is 10000.
    if (body.type === "PERCENT" && body.value > 10_000) {
      ctx.addIssue({
        code: "custom",
        path: ["value"],
        message: "Une remise en pourcentage ne peut pas dépasser 100 %.",
      });
    }
  });

export const setDiscountSchema = z.strictObject({
  version: z
    .number({ error: "Version du ticket manquante." })
    .int({ error: "Version du ticket invalide." })
    .min(1, { error: "Version du ticket invalide." }),
  discount: discountSchema.nullable(),
});
export type SetDiscountBody = z.infer<typeof setDiscountSchema>;

/* -------------------------------------------------------------------------- */
/* Order history (ORD-12)                                                      */
/* -------------------------------------------------------------------------- */

/**
 * ORD-12: filters for the sales history. Not strict — a query string picks
 * up parameters from proxies and link trackers, and refusing a request over
 * an unread `?utm_source=` would be a bug, not a safety feature.
 *
 * `OPEN` is absent from the status enum on purpose: a ticket in progress is
 * not history, so there is no filter value that could ask for one.
 */
export const orderHistoryQuerySchema = z.object({
  status: z
    .enum(["PAID", "CANCELLED", "REFUNDED"], {
      error: 'Statut invalide (attendu "PAID", "CANCELLED" ou "REFUNDED").',
    })
    .optional(),
  from: z.iso.datetime({ offset: true, error: "Date de début invalide." }).optional(),
  to: z.iso.datetime({ offset: true, error: "Date de fin invalide." }).optional(),
  limit: z.coerce
    .number({ error: "Limite invalide." })
    .int({ error: "Limite invalide." })
    .min(1, { error: "Limite invalide." })
    .max(200, { error: "La limite ne peut pas dépasser 200." })
    .default(20),
  offset: z.coerce
    .number({ error: "Décalage invalide." })
    .int({ error: "Décalage invalide." })
    .min(0, { error: "Décalage invalide." })
    .default(0),
});
export type OrderHistoryQuery = z.infer<typeof orderHistoryQuerySchema>;

/**
 * BI-02: the four history queries (ventes, paiements, caisse, stock) share
 * the same pagination shape as `orderHistoryQuerySchema` above — same
 * bounds, same defaults — so a client written against one behaves
 * predictably against the others.
 */
const historyPaginationSchema = {
  from: z.iso.datetime({ offset: true, error: "Date de début invalide." }).optional(),
  to: z.iso.datetime({ offset: true, error: "Date de fin invalide." }).optional(),
  limit: z.coerce
    .number({ error: "Limite invalide." })
    .int({ error: "Limite invalide." })
    .min(1, { error: "Limite invalide." })
    .max(200, { error: "La limite ne peut pas dépasser 200." })
    .default(20),
  offset: z.coerce
    .number({ error: "Décalage invalide." })
    .int({ error: "Décalage invalide." })
    .min(0, { error: "Décalage invalide." })
    .default(0),
};

export const soldItemsQuerySchema = z.object({
  ...historyPaginationSchema,
  productId: z.coerce.number().pipe(idSchema).optional(),
});
export type SoldItemsQuery = z.infer<typeof soldItemsQuerySchema>;

export const paymentsHistoryQuerySchema = z.object({
  ...historyPaginationSchema,
  method: paymentLineMethodSchema.optional(),
  type: paymentTypeSchema.optional(),
});
export type PaymentsHistoryQuery = z.infer<typeof paymentsHistoryQuerySchema>;

export const cashMovementsHistoryQuerySchema = z.object({
  ...historyPaginationSchema,
  type: cashMovementTypeFilterSchema.optional(),
  category: cashMovementCategorySchema.optional(),
});
export type CashMovementsHistoryQuery = z.infer<typeof cashMovementsHistoryQuerySchema>;

export const stockMovementsHistoryQuerySchema = z.object({
  ...historyPaginationSchema,
  productId: z.coerce.number().pipe(idSchema).optional(),
  type: stockMovementTypeFilterSchema.optional(),
});
export type StockMovementsHistoryQuery = z.infer<typeof stockMovementsHistoryQuerySchema>;

/**
 * BI-03: "aucun filtre visible s'il est ignoré" — a discriminated union
 * (one `z.strictObject` per period) rather than one object with every
 * field optional. `?period=year&day=12` is a 400 naming `day` as
 * unrecognised, not a silently ignored parameter that could mislead a
 * caller into thinking it narrowed anything. Mirrors
 * `lib/services/metrics.ts::MetricsQuery` field-for-field.
 */
const yearField = z.coerce
  .number({ error: "Année invalide." })
  .int({ error: "Année invalide." })
  .min(2000, { error: "Année invalide." })
  .max(2100, { error: "Année invalide." })
  .optional();
const monthField = z.coerce
  .number({ error: "Mois invalide." })
  .int({ error: "Mois invalide." })
  .min(1, { error: "Mois invalide." })
  .max(12, { error: "Mois invalide." })
  .optional();

export const metricsQuerySchema = z.discriminatedUnion("period", [
  z.strictObject({ period: z.literal("service") }),
  z.strictObject({
    period: z.literal("day"),
    year: yearField,
    month: monthField,
    day: z.coerce
      .number({ error: "Jour invalide." })
      .int({ error: "Jour invalide." })
      .min(1, { error: "Jour invalide." })
      .max(31, { error: "Jour invalide." })
      .optional(),
  }),
  z.strictObject({ period: z.literal("month"), year: yearField, month: monthField }),
  z.strictObject({ period: z.literal("year"), year: yearField }),
  z
    .strictObject({
      period: z.literal("range"),
      from: z.iso.datetime({ offset: true, error: "Date de début invalide." }),
      to: z.iso.datetime({ offset: true, error: "Date de fin invalide." }),
    })
    .refine(({ from, to }) => new Date(from) <= new Date(to), {
      error: "La date de début doit précéder la date de fin.",
      path: ["from"],
    }),
]);
export type MetricsQueryInput = z.infer<typeof metricsQuerySchema>;

/* -------------------------------------------------------------------------- */
/* Establishment configuration (CFG-01 / CFG-02 / CFG-03)                      */
/* -------------------------------------------------------------------------- */

/**
 * CFG-01. The timezone's *existence* is checked in the service, against the
 * runtime's own zone data — a hard-coded list here would go stale, and the
 * shape of the request is all a schema can honestly speak for.
 *
 * Rates and thresholds go through `moneyAmountSchema` for its 2-decimal
 * rule, and therefore arrive in hundredths: 20 % is 2000.
 */
export const updateSettingsSchema = z.strictObject({
  name: shortTextSchema(150, "Le nom de l'établissement"),
  timezone: shortTextSchema(64, "Le fuseau horaire"),
  currency: z
    .string({ error: "La devise est requise." })
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, { error: "Devise invalide : un code ISO de 3 lettres (ex. EUR)." }),
  defaultTaxRate: moneyAmountSchema,
  cashDiscrepancyThreshold: moneyAmountSchema,
});
export type UpdateSettingsBody = z.infer<typeof updateSettingsSchema>;

export const createTaxClassSchema = z.strictObject({
  name: shortTextSchema(100, "Le nom de la classe fiscale"),
  rate: moneyAmountSchema,
});
export type CreateTaxClassBody = z.infer<typeof createTaxClassSchema>;

export const categorySchema = z.strictObject({
  name: shortTextSchema(100, "Le nom de la catégorie"),
  taxClassId: idSchema.nullish(),
});
export type CategoryBody = z.infer<typeof categorySchema>;

export const updateTableActiveSchema = z.strictObject({
  isActive: z.boolean({ error: "Statut d'activation invalide." }),
});
export type UpdateTableActiveBody = z.infer<typeof updateTableActiveSchema>;

/** CFG-03: the order given is the order stored, so the list must be complete and unambiguous. */
export const reorderTablesSchema = z
  .strictObject({
    orderedIds: z
      .array(idSchema, { error: "Liste de tables invalide." })
      .min(1, { error: "Indiquez au moins une table." })
      .max(500, { error: "Trop de tables." }),
  })
  .refine((body) => new Set(body.orderedIds).size === body.orderedIds.length, {
    error: "La même table apparaît deux fois dans l'ordre demandé.",
    path: ["orderedIds"],
  });
export type ReorderTablesBody = z.infer<typeof reorderTablesSchema>;
