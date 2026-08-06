import { z } from "zod";
import {
  cashMovementTypeSchema,
  dashboardPeriodSchema,
  diningTableStatusSchema,
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
    tableId: idSchema.nullish(),
    items: z
      .array(checkoutItemSchema, { error: "Ajoutez au moins un article." })
      .min(1, { error: "Ajoutez au moins un article." })
      .max(200, { error: "Une commande ne peut pas dépasser 200 lignes." }),
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

export const updateDiningTableSchema = z
  .strictObject({
    name: shortTextSchema(100, "Le nom de la table").optional(),
    status: diningTableStatusSchema.optional(),
  })
  .refine((body) => body.name !== undefined || body.status !== undefined, {
    error: "Indiquez au moins un champ à modifier (name ou status).",
  });
export type UpdateDiningTableBody = z.infer<typeof updateDiningTableSchema>;

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
