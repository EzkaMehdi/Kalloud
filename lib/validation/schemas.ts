import { z } from "zod";
import {
  cashMovementTypeSchema,
  dashboardPeriodSchema,
  emailSchema,
  idSchema,
  moneyAmountSchema,
  noteSchema,
  paymentMethodSchema,
  quantitySchema,
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
  name: shortTextSchema(150, "Le nom du produit"),
  price: moneyAmountSchema,
  stockQuantity: stockQuantitySchema.optional(),
  alertThreshold: stockQuantitySchema.optional(),
});
export type CreateProductBody = z.infer<typeof createProductSchema>;

export const updateProductSchema = z
  .strictObject({
    name: shortTextSchema(150, "Le nom du produit").optional(),
    price: moneyAmountSchema.optional(),
    stockQuantity: stockQuantitySchema.optional(),
    alertThreshold: stockQuantitySchema.optional(),
    isActive: z.boolean({ error: "Statut d'activation invalide." }).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    error: "Indiquez au moins un champ à modifier.",
  });
export type UpdateProductBody = z.infer<typeof updateProductSchema>;

export const updateStockSchema = z.strictObject({ quantity: stockQuantitySchema });
export type UpdateStockBody = z.infer<typeof updateStockSchema>;

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
export const updateDiningTableSchema = z.strictObject({
  name: shortTextSchema(100, "Le nom de la table"),
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
    amount: moneyAmountSchema,
    reason: reasonSchema,
  })
  .refine((body) => body.amount > 0, {
    error: "Le montant doit être supérieur à zéro.",
    path: ["amount"],
  })
  .transform(({ amount, ...rest }) => ({ ...rest, amountCents: amount }));
export type CreateCashMovementBody = z.infer<typeof createCashMovementSchema>;

export const closeBusinessDaySchema = z.strictObject({
  nextOpeningCash: moneyAmountSchema.optional(),
});
export type CloseBusinessDayBody = z.infer<typeof closeBusinessDaySchema>;

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
