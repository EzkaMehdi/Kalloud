import { describe, expect, it } from "vitest";
import { allocateProportionally } from "../../lib/money-allocation";

/**
 * ORD-11: the arithmetic behind a discount shared across an order's lines.
 *
 * Worth its own unit test rather than only being exercised through a
 * checkout: the whole point of the largest-remainder method is what happens
 * to the odd centime, and that is easiest to pin down on bare numbers.
 */
describe("ORD-11: allocating one amount across weighted lines", () => {
  it("always sums back to exactly the amount allocated", () => {
    // 100 split three ways is 33.33… each: rounding each independently gives
    // 99 or 102, and either would put a figure on the receipt that the lines
    // below it contradict.
    const shares = allocateProportionally([100, 100, 100], 100);
    expect(shares.reduce((sum, share) => sum + share, 0)).toBe(100);
    expect(shares).toEqual([34, 33, 33]);
  });

  it("gives the spare centimes to the lines closest to the next one", () => {
    // 10 % of 3 lines at 3.33 €: 33.3 cents each, so two lines round down
    // and the remainder goes to the earliest of the equally-deserving ones.
    const shares = allocateProportionally([333, 333, 333], 100);
    expect(shares).toEqual([34, 33, 33]);
  });

  it("keeps shares proportional to the weights", () => {
    expect(allocateProportionally([1000, 2000, 7000], 1000)).toEqual([100, 200, 700]);
  });

  it("handles the degenerate cases without inventing money", () => {
    expect(allocateProportionally([], 500)).toEqual([]);
    expect(allocateProportionally([100, 200], 0)).toEqual([0, 0]);
    // Nothing to weigh against: allocating it all to the first line would be
    // arbitrary, so nothing is allocated.
    expect(allocateProportionally([0, 0], 100)).toEqual([0, 0]);
  });

  it("never allocates more to a line than its own weight when the total matches", () => {
    const weights = [500, 1500, 3000];
    const shares = allocateProportionally(weights, 5000);
    expect(shares).toEqual(weights);
  });
});
