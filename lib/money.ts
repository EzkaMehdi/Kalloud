/**
 * Money helpers implementing the rounding and storage rules fixed by
 * `docs/decisions/DEC-05-regles-monetaires.md`: amounts are persisted as
 * `DECIMAL(10,2)` strings, all arithmetic happens on integer cents to avoid
 * floating-point drift, and rounding is half-up to the nearest cent.
 */

export class InvalidMoneyAmountError extends RangeError {
  constructor(value: unknown) {
    super(`Invalid monetary amount: ${String(value)}`);
    this.name = "InvalidMoneyAmountError";
  }
}

/** Converts a decimal amount (number or a `DECIMAL` string from Postgres) into integer cents. */
export function toCents(amount: number | string): number {
  const value = typeof amount === "string" ? Number(amount) : amount;
  if (!Number.isFinite(value)) {
    throw new InvalidMoneyAmountError(amount);
  }
  return Math.round(value * 100);
}

/** Converts integer cents back into the `DECIMAL(10,2)`-compatible string Postgres expects. */
export function fromCents(cents: number): string {
  if (!Number.isInteger(cents)) {
    throw new InvalidMoneyAmountError(cents);
  }
  return (cents / 100).toFixed(2);
}

/** Sums integer cent amounts. Kept as a named helper so call sites read like the business rule. */
export function sumCents(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0);
}

/**
 * Extracts the tax portion of a TTC (tax-included) amount for a given percentage
 * rate, rounded half-up to the nearest cent, per `DEC-05`:
 * `taxe = ttc - ttc / (1 + taux)`.
 */
export function extractTaxCents(totalTtcCents: number, ratePercent: number): number {
  if (ratePercent < 0) {
    throw new RangeError(`Tax rate must be >= 0: ${ratePercent}`);
  }
  const totalHt = totalTtcCents / (1 + ratePercent / 100);
  return Math.round(totalTtcCents - totalHt);
}

/** Applies a percentage rate to a cent amount, rounded half-up. */
export function applyPercentCents(amountCents: number, ratePercent: number): number {
  return Math.round(amountCents * (ratePercent / 100));
}

export function formatMoney(
  amountCents: number,
  currency: string = "EUR",
  locale: string = "fr-FR",
): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(amountCents / 100);
}
