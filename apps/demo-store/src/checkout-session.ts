/** What the store's server answers for a new checkout: the order plus the values the widget must pin. */
export interface CheckoutSession {
  orderId: string;
  /** Cart total the server priced from its own catalog, as a decimal USDT string (e.g. "58.500000"). */
  amount: string;
  /** The store's payout address. */
  payout: string;
}

/** Validates the store server's /api/checkout answer; anything incomplete is treated as a failed checkout. */
export function parseCheckoutSession(body: unknown): CheckoutSession {
  const b = (body ?? {}) as Partial<Record<keyof CheckoutSession, unknown>>;
  if (
    typeof b.orderId !== "string" ||
    !/^0x[0-9a-fA-F]{64}$/.test(b.orderId) ||
    typeof b.amount !== "string" ||
    !/^[0-9]+(\.[0-9]+)?$/.test(b.amount) ||
    typeof b.payout !== "string" ||
    !/^0x[0-9a-fA-F]{40}$/.test(b.payout)
  ) {
    throw new Error("malformed checkout response");
  }
  return { orderId: b.orderId, amount: b.amount, payout: b.payout };
}
