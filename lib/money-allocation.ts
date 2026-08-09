/**
 * ORD-11/DEC-05: sharing one amount out across several lines, in cents,
 * without losing or inventing a centime.
 *
 * A 10 % discount on a three-line order is not three independent
 * roundings: `round(a×0.1) + round(b×0.1) + round(c×0.1)` can land a cent
 * either side of `round((a+b+c)×0.1)`, and the two figures end up on the
 * same receipt — one as the discount, one as the sum of the lines. DEC-05
 * is explicit that "le total de la commande est la somme des lignes déjà
 * arrondies, jamais un recalcul global qui diverge du détail affiché".
 *
 * So the shares are floored, and the remaining cents are handed out one by
 * one to the lines with the largest fractional part (the largest-remainder
 * method). The result always sums to exactly `totalToAllocate`, and the
 * lines that were closest to the next cent are the ones that get it.
 */
export function allocateProportionally(
  weights: readonly number[],
  totalToAllocate: number,
): number[] {
  if (totalToAllocate === 0 || weights.length === 0) {
    return weights.map(() => 0);
  }

  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  if (weightSum <= 0) {
    // Nothing to weigh against — putting it all on the first line would be
    // arbitrary, so allocate nothing and let the caller notice.
    return weights.map(() => 0);
  }

  const exact = weights.map((weight) => (weight * totalToAllocate) / weightSum);
  const shares = exact.map((value) => Math.floor(value));
  let remainder = totalToAllocate - shares.reduce((sum, share) => sum + share, 0);

  const byFractionDesc = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((left, right) => right.fraction - left.fraction || left.index - right.index);

  for (const { index } of byFractionDesc) {
    if (remainder <= 0) break;
    shares[index] += 1;
    remainder -= 1;
  }

  return shares;
}
