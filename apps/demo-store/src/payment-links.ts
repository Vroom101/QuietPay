import { ORDER_TOKEN_HEADER } from "@quietpay/shared";
import { rememberToken } from "./order-token";
import { parseCheckoutSession, type CheckoutSession } from "./checkout-session";

export interface PublicLinkView {
  id: string;
  title: string;
  description: string | null;
  /** Decimal USDT string. */
  amount: string;
  status: "active" | "paid" | "deactivated" | "expired";
  expiresAt: string | null;
  merchantName: string;
}

export const LINK_STATUS_MESSAGE = {
  paid: "This link has already been paid",
  deactivated: "This link is no longer active",
  expired: "This link has expired",
} as const;

async function call(path: string, init?: RequestInit) {
  const response = await fetch(path, init);
  const body = await response.json().catch(() => undefined);
  if (!response.ok) {
    const message = (body as { error?: unknown } | undefined)?.error;
    throw new Error(typeof message === "string" && message ? message : "This payment link is unavailable. Please try again.");
  }
  return { body, response };
}

export async function getLink(id: string, signal?: AbortSignal): Promise<PublicLinkView> {
  return (await call(`/api/links/${encodeURIComponent(id)}`, { signal })).body as PublicLinkView;
}

/** Starts a payment for the link and keeps the customer's order token (tab-scoped), as the cart checkout does. */
export async function startLinkCheckout(id: string): Promise<CheckoutSession> {
  const { body, response } = await call(`/api/links/${encodeURIComponent(id)}/checkout`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const checkout = parseCheckoutSession((body as { checkout?: unknown } | undefined)?.checkout);
  const token = response.headers.get(ORDER_TOKEN_HEADER);
  if (token) rememberToken(checkout.orderId, token);
  return checkout;
}
