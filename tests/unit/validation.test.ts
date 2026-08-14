import { describe, expect, it } from "vitest";
import { ValidationError } from "../../lib/errors";
import { parseOrThrow } from "../../lib/validation/parse";
import {
  cashMovementTypeSchema,
  dateRangeSchema,
  emailSchema,
  idParamSchema,
  idSchema,
  moneyAmountSchema,
  paginationSchema,
  paymentMethodSchema,
  percentSchema,
  quantitySchema,
  reasonSchema,
  roleSchema,
  stockQuantitySchema,
} from "../../lib/validation/primitives";
import {
  cancelTicketSchema,
  checkoutBodySchema,
  createCashMovementSchema,
  createProductSchema,
  dashboardQuerySchema,
  saveTicketItemsSchema,
  updateDiningTableSchema,
  updateProductSchema,
} from "../../lib/validation/schemas";

/** Small helper: `true` when the schema accepts the value. */
function accepts(schema: { safeParse(value: unknown): { success: boolean } }, value: unknown) {
  return schema.safeParse(value).success;
}

describe("API-01: money amounts follow DEC-05", () => {
  it("rejects more than two decimals, the case DEC-05 calls out by name", () => {
    // "un produit à 4,995 € (prix mal saisi) est refusé à la saisie
    //  (API-01 impose 2 décimales exactes)"
    expect(accepts(moneyAmountSchema, 4.995)).toBe(false);
    expect(accepts(moneyAmountSchema, "4.995")).toBe(false);
    expect(accepts(moneyAmountSchema, 0.001)).toBe(false);
  });

  it("converts accepted amounts to integer cents", () => {
    expect(moneyAmountSchema.parse("12.34")).toBe(1234);
    expect(moneyAmountSchema.parse(12.34)).toBe(1234);
    expect(moneyAmountSchema.parse(12.3)).toBe(1230);
    expect(moneyAmountSchema.parse("12.30")).toBe(1230);
    expect(moneyAmountSchema.parse(12)).toBe(1200);
    expect(moneyAmountSchema.parse("0")).toBe(0);
    expect(moneyAmountSchema.parse(" 7.05 ")).toBe(705);
  });

  it("rejects negatives, non-finite values and non-numeric text", () => {
    for (const value of [-1, -0.01, "-5.00", NaN, Infinity, -Infinity, "abc", "", "1,50", true]) {
      expect(accepts(moneyAmountSchema, value), `expected ${String(value)} to be rejected`).toBe(
        false,
      );
    }
  });

  it("rejects exponent notation rather than silently reinterpreting it", () => {
    // String(1e21) is "1e+21"; accepting it would insert an absurd amount.
    expect(accepts(moneyAmountSchema, 1e21)).toBe(false);
    expect(accepts(moneyAmountSchema, "1e3")).toBe(false);
  });

  it("rejects amounts wider than DECIMAL(10,2)", () => {
    expect(accepts(moneyAmountSchema, "99999999.99")).toBe(true);
    expect(accepts(moneyAmountSchema, "100000000.00")).toBe(false);
  });
});

describe("API-01: identifiers and quantities", () => {
  it("rejects anything that is not a positive integer id", () => {
    expect(idSchema.parse(1)).toBe(1);
    for (const value of [0, -1, 1.5, "1", null, undefined, NaN, 2_147_483_648]) {
      expect(accepts(idSchema, value), `expected ${String(value)} to be rejected`).toBe(false);
    }
  });

  it("parses route segments strictly, without JavaScript's numeric coercions", () => {
    expect(idParamSchema.parse("42")).toBe(42);
    // Number("4e2") is 400 and Number(" 42 ") is 42: both would silently
    // address a different row than the URL says.
    for (const value of ["4e2", " 42 ", "0x1f", "42.0", "-1", "0", "", "abc"]) {
      expect(accepts(idParamSchema, value), `expected "${value}" to be rejected`).toBe(false);
    }
  });

  it("requires order quantities to be whole and at least one", () => {
    expect(quantitySchema.parse(3)).toBe(3);
    for (const value of [0, -2, 1.5, 10_000]) {
      expect(accepts(quantitySchema, value), `expected ${value} to be rejected`).toBe(false);
    }
  });

  it("allows zero for absolute stock counts, which order quantities forbid", () => {
    expect(stockQuantitySchema.parse(0)).toBe(0);
    expect(accepts(stockQuantitySchema, -1)).toBe(false);
    expect(accepts(quantitySchema, 0)).toBe(false);
  });
});

describe("API-01: text, rates, enums and ranges", () => {
  it("trims text and refuses whitespace-only or over-long values", () => {
    expect(reasonSchema.parse("  Achat urgent  ")).toBe("Achat urgent");
    expect(accepts(reasonSchema, "   ")).toBe(false);
    expect(accepts(reasonSchema, "")).toBe(false);
    expect(accepts(reasonSchema, "x".repeat(256))).toBe(false);
  });

  it("bounds percentage rates to DECIMAL(5,2) and 0-100", () => {
    expect(percentSchema.parse(20)).toBe(20);
    expect(percentSchema.parse(10.1)).toBe(10.1);
    expect(percentSchema.parse(5.5)).toBe(5.5);
    expect(accepts(percentSchema, 20.005)).toBe(false);
    expect(accepts(percentSchema, -1)).toBe(false);
    expect(accepts(percentSchema, 101)).toBe(false);
  });

  it("normalises e-mail addresses and rejects malformed ones", () => {
    expect(emailSchema.parse("  Owner@Example.test ")).toBe("Owner@Example.test");
    expect(accepts(emailSchema, "not-an-email")).toBe(false);
    expect(accepts(emailSchema, "")).toBe(false);
  });

  it("accepts exactly the documented enum values and nothing else", () => {
    const cases: [{ safeParse(value: unknown): { success: boolean } }, string[], string[]][] = [
      [paymentMethodSchema, ["CASH", "CARD", "MIXED"], ["cash", "CHEQUE", ""]],
      [cashMovementTypeSchema, ["IN", "OUT"], ["OPENING", "in", ""]],
      [roleSchema, ["OWNER", "MANAGER", "CASHIER"], ["ADMIN", "owner"]],
    ];
    for (const [schema, valid, invalid] of cases) {
      for (const value of valid) expect(accepts(schema, value), `accept ${value}`).toBe(true);
      for (const value of invalid) expect(accepts(schema, value), `reject ${value}`).toBe(false);
    }
  });

  it("refuses a cash movement typed OPENING, which only the system may create", () => {
    // OPENING movements are written by the business-day service alone
    // (fond de caisse); a cashier must not be able to post one by hand.
    expect(accepts(cashMovementTypeSchema, "OPENING")).toBe(false);
  });

  it("refuses an inverted date range instead of returning an empty report", () => {
    expect(
      accepts(dateRangeSchema, { from: "2026-08-01T00:00:00Z", to: "2026-08-31T23:59:59Z" }),
    ).toBe(true);
    expect(
      accepts(dateRangeSchema, { from: "2026-08-31T00:00:00Z", to: "2026-08-01T00:00:00Z" }),
    ).toBe(false);
    expect(accepts(dateRangeSchema, { from: "2026-08-01", to: "2026-08-31" })).toBe(false);
  });

  it("defaults and bounds pagination", () => {
    expect(paginationSchema.parse({})).toEqual({ limit: 50, offset: 0 });
    expect(paginationSchema.parse({ limit: "10", offset: "20" })).toEqual({
      limit: 10,
      offset: 20,
    });
    expect(accepts(paginationSchema, { limit: 500 })).toBe(false);
    expect(accepts(paginationSchema, { offset: -1 })).toBe(false);
  });
});

describe("API-01: checkout payload invariants (DEC-05)", () => {
  // ORD-07: a checkout settles a ticket. The body names it and describes how
  // it was paid — the lines live in the database, so `items` and `tableId`
  // are gone from this schema entirely.
  const base = { orderId: 7 };

  it("accepts each payment method with a coherent split and returns cents", () => {
    expect(
      checkoutBodySchema.parse({ ...base, paymentMethod: "CASH", cashAmount: 20 }),
    ).toMatchObject({ orderId: 7, cashAmountCents: 2000, cardAmountCents: 0 });
    expect(
      checkoutBodySchema.parse({ ...base, paymentMethod: "CARD", cardAmount: "20.00" }),
    ).toMatchObject({ cashAmountCents: 0, cardAmountCents: 2000 });
    expect(
      checkoutBodySchema.parse({
        ...base,
        paymentMethod: "MIXED",
        cashAmount: 5,
        cardAmount: 15,
      }),
    ).toMatchObject({ cashAmountCents: 500, cardAmountCents: 1500 });
  });

  it("refuses a card amount on a cash sale and vice versa", () => {
    expect(
      accepts(checkoutBodySchema, {
        ...base,
        paymentMethod: "CASH",
        cashAmount: 20,
        cardAmount: 5,
      }),
    ).toBe(false);
    expect(
      accepts(checkoutBodySchema, {
        ...base,
        paymentMethod: "CARD",
        cashAmount: 5,
        cardAmount: 20,
      }),
    ).toBe(false);
  });

  it("refuses a MIXED payment that is not actually split", () => {
    // This is audit finding P0-02 made impossible at the contract level:
    // the UI used to send MIXED with both amounts at zero, and the server
    // quietly recorded the whole sale as card revenue.
    expect(accepts(checkoutBodySchema, { ...base, paymentMethod: "MIXED" })).toBe(false);
    expect(
      accepts(checkoutBodySchema, {
        ...base,
        paymentMethod: "MIXED",
        cashAmount: 0,
        cardAmount: 20,
      }),
    ).toBe(false);
  });

  it("requires a ticket, and refuses a bogus one", () => {
    expect(accepts(checkoutBodySchema, { paymentMethod: "CARD", cardAmount: 5 })).toBe(false);
    expect(accepts(checkoutBodySchema, { orderId: 0, paymentMethod: "CARD" })).toBe(false);
    expect(accepts(checkoutBodySchema, { orderId: -3, paymentMethod: "CARD" })).toBe(false);
  });

  it("refuses a line list — a checkout may no longer carry its own items", () => {
    // ORD-07: the only source of a sale's contents is the ticket it
    // settles. Accepting `items` here, even to ignore them, would leave the
    // impression a client can influence what it is charged for.
    expect(
      accepts(checkoutBodySchema, {
        ...base,
        paymentMethod: "CARD",
        items: [{ productId: 1, quantity: 1 }],
      }),
    ).toBe(false);
    expect(accepts(checkoutBodySchema, { ...base, paymentMethod: "CARD", tableId: 2 })).toBe(false);
  });

  it("rejects an unrecognised key instead of ignoring it", () => {
    // A `cardAmout` typo used to become a zero-euro card payment.
    expect(accepts(checkoutBodySchema, { ...base, paymentMethod: "CARD", cardAmout: 20 })).toBe(
      false,
    );
  });
});

describe("API-01/ORD-05: ticket line invariants", () => {
  it("requires the version the caller read", () => {
    expect(accepts(saveTicketItemsSchema, { items: [] })).toBe(false);
    expect(accepts(saveTicketItemsSchema, { version: 0, items: [] })).toBe(false);
    expect(saveTicketItemsSchema.parse({ version: 3, items: [] })).toEqual({
      version: 3,
      items: [],
    });
  });

  it("accepts an empty ticket — emptying one is a real action", () => {
    expect(accepts(saveTicketItemsSchema, { version: 1, items: [] })).toBe(true);
  });

  it("rejects malformed lines", () => {
    expect(
      accepts(saveTicketItemsSchema, { version: 1, items: [{ productId: 0, quantity: 1 }] }),
    ).toBe(false);
    expect(
      accepts(saveTicketItemsSchema, { version: 1, items: [{ productId: 1, quantity: 0 }] }),
    ).toBe(false);
  });
});

describe("API-01/ORD-06: cancelling a ticket needs a motive", () => {
  it("refuses a cancellation with no reason, or a blank one", () => {
    expect(accepts(cancelTicketSchema, {})).toBe(false);
    expect(accepts(cancelTicketSchema, { reason: "   " })).toBe(false);
    expect(cancelTicketSchema.parse({ reason: "  Client parti  " })).toEqual({
      reason: "Client parti",
    });
  });
});

describe("API-01: catalog, floor plan and cash payloads", () => {
  it("requires a named, priced product", () => {
    expect(createProductSchema.parse({ name: " Café ", price: "2.50" })).toMatchObject({
      name: "Café",
      price: 250,
    });
    expect(accepts(createProductSchema, { price: "2.50" })).toBe(false);
    expect(accepts(createProductSchema, { name: "Café" })).toBe(false);
    expect(accepts(createProductSchema, { name: "   ", price: "2.50" })).toBe(false);
    expect(accepts(createProductSchema, { name: "Café", price: "2.505" })).toBe(false);
  });

  it("refuses an empty update rather than issuing a no-op write", () => {
    expect(accepts(updateProductSchema, {})).toBe(false);
    expect(accepts(updateDiningTableSchema, {})).toBe(false);
    expect(accepts(updateProductSchema, { isActive: false })).toBe(true);
  });

  it("requires a strictly positive cash movement with a motive", () => {
    expect(
      createCashMovementSchema.parse({
        type: "IN",
        category: "FUND_TOPUP",
        amount: "20.00",
        reason: " Monnaie ",
      }),
    ).toEqual({ type: "IN", category: "FUND_TOPUP", amountCents: 2000, reason: "Monnaie" });
    expect(
      accepts(createCashMovementSchema, {
        type: "IN",
        category: "OTHER",
        amount: 0,
        reason: "Rien",
      }),
    ).toBe(false);
    expect(
      accepts(createCashMovementSchema, {
        type: "IN",
        category: "OTHER",
        amount: 20,
        reason: "  ",
      }),
    ).toBe(false);
  });

  /**
   * CASH-03/DEC-11. The pairing matters more than the enum: a category is
   * only meaningful for one direction, and an END_OF_SERVICE_WITHDRAWAL
   * recorded as an *inflow* is not a typo to tolerate — CASH-04 sums that
   * category apart from the others to avoid double-counting withdrawals.
   */
  it("pairs a cash movement category with its direction", () => {
    const base = { amount: "20.00", reason: "Motif" };

    expect(accepts(createCashMovementSchema, { ...base, type: "OUT", category: "PURCHASE" })).toBe(
      true,
    );
    expect(
      accepts(createCashMovementSchema, {
        ...base,
        type: "OUT",
        category: "END_OF_SERVICE_WITHDRAWAL",
      }),
    ).toBe(true);
    // "OTHER" is the one category both directions accept.
    expect(accepts(createCashMovementSchema, { ...base, type: "IN", category: "OTHER" })).toBe(
      true,
    );

    // An outflow category on an inflow, and the reverse.
    expect(accepts(createCashMovementSchema, { ...base, type: "IN", category: "PURCHASE" })).toBe(
      false,
    );
    expect(
      accepts(createCashMovementSchema, { ...base, type: "IN", category: "BANK_DEPOSIT" }),
    ).toBe(false);
    expect(
      accepts(createCashMovementSchema, { ...base, type: "OUT", category: "FUND_TOPUP" }),
    ).toBe(false);

    // The opening float is not something a client may record at all: it is
    // excluded from the accepted types, and its category from the enum.
    expect(
      accepts(createCashMovementSchema, { ...base, type: "OPENING", category: "OPENING_FLOAT" }),
    ).toBe(false);

    // Stating a category is mandatory — no silent fallback to "OTHER", which
    // would let every movement be filed as uncategorised without anyone
    // choosing that.
    expect(accepts(createCashMovementSchema, { ...base, type: "OUT" })).toBe(false);
  });

  it("defaults the dashboard period but rejects an unknown one", () => {
    expect(dashboardQuerySchema.parse({})).toMatchObject({ period: "day" });
    expect(dashboardQuerySchema.parse({ period: "month", year: "2026" })).toMatchObject({
      period: "month",
      year: 2026,
    });
    // Previously `?period=nonsense` silently fell back to "day".
    expect(accepts(dashboardQuerySchema, { period: "nonsense" })).toBe(false);
    expect(accepts(dashboardQuerySchema, { month: "99" })).toBe(false);
  });
});

describe("API-01: failures arrive as the application's own error contract", () => {
  it("throws a ValidationError, not a ZodError", () => {
    expect(() => parseOrThrow(idSchema, "nope")).toThrow(ValidationError);
  });

  it("carries the offending field path so a form can highlight the input", () => {
    try {
      parseOrThrow(saveTicketItemsSchema, {
        version: 1,
        items: [{ productId: 1, quantity: 0 }],
      });
      expect.unreachable("expected a ValidationError");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const validation = error as ValidationError;
      expect(validation.statusCode).toBe(400);
      expect(validation.code).toBe("VALIDATION_ERROR");
      expect(validation.details?.[0].field).toBe("items[0].quantity");
      expect(validation.message).toContain("quantité");
    }
  });

  it("keeps details absent when there is nothing field-specific to report", () => {
    expect(new ValidationError("Aucune journée ouverte.").details).toBeUndefined();
  });
});
