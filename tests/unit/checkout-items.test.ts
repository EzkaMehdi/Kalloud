import { describe, expect, it } from "vitest";
import { mergeItemsByProduct } from "../../lib/services/checkout";
import { checkoutBodySchema } from "../../lib/validation/schemas";

/** Builds the validated `items` array the service receives, via the real schema. */
function items(raw: { productId: number; quantity: number; notes?: string }[]) {
  return checkoutBodySchema.parse({
    items: raw,
    paymentMethod: "CARD",
    cardAmount: "10.00",
  }).items;
}

describe("API-02: checkout lines are locked in a deterministic order", () => {
  it("returns products sorted by id whatever order the client sent them in", () => {
    // This is the property that prevents the deadlock: two concurrent sales
    // touching {12, 7} and {7, 12} both take their FOR UPDATE locks as
    // 7-then-12, so one simply waits for the other instead of the pair
    // holding what each other needs. An integration test cannot demonstrate
    // this — forcing the interleaving requires pausing a transaction
    // mid-flight — so the ordering itself is asserted here.
    const forward = mergeItemsByProduct(
      items([
        { productId: 12, quantity: 1 },
        { productId: 7, quantity: 1 },
        { productId: 30, quantity: 1 },
      ]),
    );
    const reverse = mergeItemsByProduct(
      items([
        { productId: 30, quantity: 1 },
        { productId: 7, quantity: 1 },
        { productId: 12, quantity: 1 },
      ]),
    );

    expect(forward.map((item) => item.productId)).toEqual([7, 12, 30]);
    expect(reverse.map((item) => item.productId)).toEqual([7, 12, 30]);
  });

  it("sorts numerically, not lexicographically", () => {
    // A default .sort() would order these as 10, 2, 9 — a stable order, but
    // not the same one another code path computing ids numerically would
    // choose, which is how ordering bugs come back.
    const merged = mergeItemsByProduct(
      items([
        { productId: 10, quantity: 1 },
        { productId: 2, quantity: 1 },
        { productId: 9, quantity: 1 },
      ]),
    );
    expect(merged.map((item) => item.productId)).toEqual([2, 9, 10]);
  });
});

describe("API-02: repeated lines of one product are merged", () => {
  it("sums the quantities into a single line", () => {
    // The stock check runs once, against 5, instead of twice against 3.
    const merged = mergeItemsByProduct(
      items([
        { productId: 4, quantity: 3 },
        { productId: 4, quantity: 2 },
      ]),
    );
    expect(merged).toEqual([{ productId: 4, quantity: 5, notes: null }]);
  });

  it("keeps the notes of every merged line", () => {
    const merged = mergeItemsByProduct(
      items([
        { productId: 4, quantity: 1, notes: "sans glace" },
        { productId: 4, quantity: 1, notes: "bien tassé" },
      ]),
    );
    expect(merged[0].notes).toBe("sans glace — bien tassé");
  });

  it("leaves distinct products untouched", () => {
    const merged = mergeItemsByProduct(
      items([
        { productId: 1, quantity: 2 },
        { productId: 2, quantity: 3 },
      ]),
    );
    expect(merged).toEqual([
      { productId: 1, quantity: 2, notes: null },
      { productId: 2, quantity: 3, notes: null },
    ]);
  });
});
