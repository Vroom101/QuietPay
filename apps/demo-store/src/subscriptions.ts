import { ORDER_TOKEN_HEADER } from "@quietpay/shared";
import { rememberToken } from "./order-token";
import { parseCheckoutSession, type CheckoutSession } from "./checkout-session";

export type PlanInterval = "day" | "week" | "month" | "year";

export interface PlanView {
  id: string;
  name: string;
  /** Decimal USDT string. */
  amount: string;
  amountBase: string;
  interval: PlanInterval;
  intervalCount: number;
}

export interface SubscriptionView {
  id: string;
  plan: PlanView;
  status: "active" | "past_due" | "cancelled";
  paidPeriods: number;
  nextCharge: string | null;
  due: boolean;
  pendingOrderId?: string;
  lastPaidOrderId?: string;
}

export interface SubscriptionCheckout {
  subscription: SubscriptionView;
  checkout: CheckoutSession;
}

async function call<T>(path: string, init?: RequestInit): Promise<{ body: T; response: Response }> {
  const response = await fetch(path, init);
  const body = await response.json().catch(() => undefined);
  if (!response.ok) {
    const message = (body as { error?: unknown } | undefined)?.error;
    throw new Error(typeof message === "string" && message ? message : "Subscriptions are unavailable. Please try again.");
  }
  return { body: body as T, response };
}

function post<T>(path: string, body?: object) {
  return call<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

/** Validates the checkout part and keeps the customer's order token (tab-scoped) exactly as the cart checkout does. */
function withCheckout(result: { body: { subscription: SubscriptionView; checkout: unknown }; response: Response }): SubscriptionCheckout {
  const checkout = parseCheckoutSession(result.body.checkout);
  const token = result.response.headers.get(ORDER_TOKEN_HEADER);
  if (token) rememberToken(checkout.orderId, token);
  return { subscription: result.body.subscription, checkout };
}

const enc = encodeURIComponent;

export async function getPlan(id: string, signal?: AbortSignal): Promise<PlanView> {
  return (await call<PlanView>(`/api/plans/${enc(id)}`, { signal })).body;
}

export async function getSubscription(id: string, signal?: AbortSignal): Promise<SubscriptionView> {
  return (await call<SubscriptionView>(`/api/subscriptions/${enc(id)}`, { signal })).body;
}

export async function subscribe(planId: string): Promise<SubscriptionCheckout> {
  return withCheckout(await post(`/api/plans/${enc(planId)}/subscribe`, { consent: true }));
}

export async function renew(id: string): Promise<SubscriptionCheckout> {
  return withCheckout(await post(`/api/subscriptions/${enc(id)}/renew`));
}

export async function cancelSubscription(id: string): Promise<SubscriptionView> {
  return (await post<SubscriptionView>(`/api/subscriptions/${enc(id)}/cancel`)).body;
}

/** "every month" or "every 3 months". */
export function intervalLabel(plan: Pick<PlanView, "interval" | "intervalCount">): string {
  return plan.intervalCount > 1 ? `every ${plan.intervalCount} ${plan.interval}s` : `every ${plan.interval}`;
}
