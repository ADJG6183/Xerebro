/**
 * Money is ALWAYS integer minor units (cents for USD). See docs/DataModel.md.
 * `number` is safe to ±2^53−1 minor units (~$90 trillion); Postgres stores bigint.
 * A float in a money path is an invariant violation (docs/SystemInvariants.md).
 */
export type MinorUnits = number;

export function assertMinorUnits(value: number, label = "amount"): MinorUnits {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${label} must be integer minor units, got ${value}`);
  }
  return value;
}

export function sumMinor(values: readonly MinorUnits[]): MinorUnits {
  let total = 0;
  for (const v of values) total += assertMinorUnits(v);
  return assertMinorUnits(total, "sum");
}

/** Display-only formatting using integer math (no float division). */
export function formatMinor(amount: MinorUnits, currency = "USD"): string {
  assertMinorUnits(amount);
  const sign = amount < 0 ? "-" : "";
  const abs = Math.abs(amount);
  const units = Math.trunc(abs / 100);
  const cents = String(abs % 100).padStart(2, "0");
  const symbol = currency === "USD" ? "$" : `${currency} `;
  return `${sign}${symbol}${units.toLocaleString("en-US")}.${cents}`;
}
