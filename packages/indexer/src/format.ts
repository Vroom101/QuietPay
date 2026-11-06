import { token } from "@quietpay/shared";

/** Formats integer base units as a decimal string with exactly `decimals` places (default: the token's decimals
 *  from token.json, never a hardcoded 6). No floating point. */
export function formatAmount(base: bigint, decimals: number = token.decimals): string {
  const neg = base < 0n;
  const v = neg ? -base : base;
  const scale = 10n ** BigInt(decimals);
  const whole = v / scale;
  const frac = (v % scale).toString().padStart(decimals, "0");
  return `${neg ? "-" : ""}${whole.toString()}${decimals === 0 ? "" : "." + frac}`;
}

export const ZERO_AMOUNT = formatAmount(0n);
