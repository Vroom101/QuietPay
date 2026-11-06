import tokenJson from "../token.json";

/** Thrown for any amount string that is not an exact, in-range decimal. Stable `code` for API and UI mapping. */
export class InvalidAmountError extends Error {
  readonly code = "invalid_amount" as const;
  constructor(message: string) {
    super(message);
    this.name = "InvalidAmountError";
  }
}

/**
 * Upper bound on a single amount, in whole tokens (1,000,000,000). Absurd values fail early, before they reach
 * a signature, a database column or a gas estimate.
 */
export const MAX_WHOLE_UNITS = 1_000_000_000n;

const patternFor = (decimals: number) => new RegExp(`^(0|[1-9][0-9]*)(\\.[0-9]{1,${decimals}})?$`);

function parse(input: unknown, decimals: number, allowZero: boolean): bigint {
  if (typeof input !== "string") throw new InvalidAmountError("amount must be a string");
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new InvalidAmountError("bad token decimals");
  // Only a plain decimal: digits and at most `decimals` fractional digits. No sign, spaces, exponent, separators,
  // "+", "0x", empty string, lone ".", or leading zeros. Never rounds or truncates.
  if (decimals === 0 ? !/^(0|[1-9][0-9]*)$/.test(input) : !patternFor(decimals).test(input)) {
    throw new InvalidAmountError(`"${input.slice(0, 40)}" is not a valid amount with at most ${decimals} decimals`);
  }
  const [whole, frac = ""] = input.split(".");
  const scale = 10n ** BigInt(decimals);
  const value = BigInt(whole!) * scale + BigInt(frac.padEnd(decimals, "0") || "0");
  if (value > MAX_WHOLE_UNITS * scale) throw new InvalidAmountError("amount is too large");
  if (value === 0n && !allowZero) throw new InvalidAmountError("amount must be greater than zero");
  return value;
}

/** Parses a payment amount ("25.5") into token base units. Rejects zero. Decimals come from token.json by default. */
export function parseUsdt(amount: string, decimals: number = tokenJson.decimals): bigint {
  return parse(amount, decimals, false);
}

/** Same rules as `parseUsdt` but accepts zero, for fields such as a fee that may legitimately be 0. */
export function parseUsdtAllowZero(amount: string, decimals: number = tokenJson.decimals): bigint {
  return parse(amount, decimals, true);
}

function toBigInt(v: bigint | string): bigint {
  if (typeof v === "bigint") return v;
  if (!/^[0-9]+$/.test(v)) throw new InvalidAmountError("base units must be a non-negative integer string");
  return BigInt(v);
}

/**
 * Exact formatting: always the full number of decimals ("25.000000", "0.000001"). Use this for invoices, exports,
 * logs, and anything signed or stored, so a small difference is never hidden.
 */
export function formatUsdt(base: bigint | string, decimals: number = tokenJson.decimals): string {
  const v = toBigInt(base);
  if (decimals === 0) return v.toString();
  const scale = 10n ** BigInt(decimals);
  return `${(v / scale).toString()}.${(v % scale).toString().padStart(decimals, "0")}`;
}

/**
 * LOSSY, display only. Truncates (never rounds) to `places` decimals (default 2), so 0.000001 shows as "0.00".
 * Never use this for anything that is signed, stored, exported or compared; use `formatUsdt`.
 */
export function formatUsdtShort(base: bigint | string, places = 2, decimals: number = tokenJson.decimals): string {
  const exact = formatUsdt(base, decimals);
  if (decimals === 0) return exact;
  const [whole, frac] = exact.split(".") as [string, string];
  const p = Math.min(Math.max(places, 0), decimals);
  return p === 0 ? whole : `${whole}.${frac.slice(0, p)}`;
}
