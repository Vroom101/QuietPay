/** Formats integer base units as a decimal string with exactly `decimals` places. No floating point. */
export function formatAmount(base: bigint, decimals = 6): string {
  const neg = base < 0n;
  const v = neg ? -base : base;
  const scale = 10n ** BigInt(decimals);
  const whole = v / scale;
  const frac = (v % scale).toString().padStart(decimals, "0");
  return `${neg ? "-" : ""}${whole.toString()}.${frac}`;
}

export const ZERO_AMOUNT = formatAmount(0n);
