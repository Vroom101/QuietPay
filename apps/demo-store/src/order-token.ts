/**
 * The customer's order status token (shown once by POST /api/checkout, in the Quietpay-Order-Token header).
 * Kept in this browser tab's sessionStorage only, never in a URL and never in localStorage.
 */
const key = (orderId: string) => `qp-order-token:${orderId.toLowerCase()}`;

export function rememberToken(orderId: string, token: string): void {
  try {
    sessionStorage.setItem(key(orderId), token);
  } catch {
    /* private mode or storage disabled: the status endpoints then answer as for an unknown order */
  }
}

export function tokenFor(orderId: string): string | undefined {
  try {
    return sessionStorage.getItem(key(orderId)) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Header object for fetches that need the customer token (empty when there is none). */
export function tokenHeaders(orderId: string): Record<string, string> {
  const t = tokenFor(orderId);
  return t ? { "Quietpay-Order-Token": t } : {};
}
