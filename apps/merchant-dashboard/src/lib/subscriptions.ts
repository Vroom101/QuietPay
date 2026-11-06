/** Typed client for the store's /plans and /subscriptions routes, plus recurring-revenue maths (bigint base units). */
export type Interval = "day" | "week" | "month" | "year";
export const intervals: Interval[] = ["day", "week", "month", "year"];

export interface PlanView {
  id: string;
  name: string;
  amount: string;
  amountBase: string;
  interval: Interval;
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
export type MerchantSubscription = SubscriptionView & { customer: string; createdAt: string | number };

export class SubscriptionsError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

interface Opts {
  merchantUrl: string;
  token: string;
  fetch?: typeof fetch;
}

async function call<T>(opts: Opts, path: string, payload?: unknown): Promise<T> {
  if (!opts.token) throw new SubscriptionsError("Sign in to manage subscriptions.", 401);
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(`${opts.merchantUrl.replace(/\/+$/, "")}${path}`, {
      method: payload === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${opts.token}`, ...(payload === undefined ? {} : { "content-type": "application/json" }) },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
  } catch {
    throw new SubscriptionsError("The merchant server is not reachable.");
  }
  const body = (await res.json().catch(() => undefined)) as { error?: unknown } | undefined;
  if (!res.ok) {
    if (res.status === 401) throw new SubscriptionsError("Your session expired. Sign in again.", 401);
    const e = body?.error;
    const msg = typeof e === "string" ? e : e && typeof e === "object" && typeof (e as { message?: unknown }).message === "string" ? (e as { message: string }).message : "";
    throw new SubscriptionsError(msg || `Request failed (${res.status}).`, res.status);
  }
  return body as T;
}

export async function listPlans(opts: Opts): Promise<PlanView[]> {
  const b = await call<{ plans?: PlanView[] }>(opts, "/plans");
  if (!Array.isArray(b?.plans)) throw new SubscriptionsError("The plans response was malformed.");
  return b.plans;
}

export const createPlan = (opts: Opts, plan: { name: string; amount: string; interval: Interval; intervalCount?: number }) =>
  call<PlanView>(opts, "/plans", plan);

export async function listSubscriptions(opts: Opts): Promise<MerchantSubscription[]> {
  const b = await call<{ subscriptions?: MerchantSubscription[] }>(opts, "/subscriptions");
  if (!Array.isArray(b?.subscriptions)) throw new SubscriptionsError("The subscriptions response was malformed.");
  return b.subscriptions;
}

/** One plan's price per month, in base units (truncating): day*30, week*52/12, year/12, divided by the interval count. */
export function monthlyBase(plan: Pick<PlanView, "amountBase" | "interval" | "intervalCount">): bigint {
  const amount = BigInt(plan.amountBase);
  const n = BigInt(Math.max(1, Math.floor(plan.intervalCount || 1)));
  switch (plan.interval) {
    case "day": return (amount * 30n) / n;
    case "week": return (amount * 52n) / (12n * n);
    case "month": return amount / n;
    case "year": return amount / (12n * n);
  }
}

export function summarize(subs: Pick<SubscriptionView, "status" | "plan">[]): { active: number; mrrBase: bigint } {
  let active = 0;
  let mrrBase = 0n;
  for (const s of subs) {
    if (s.status !== "active") continue;
    active++;
    mrrBase += monthlyBase(s.plan);
  }
  return { active, mrrBase };
}

export const statusLabel = (s: Pick<SubscriptionView, "status" | "due">) =>
  s.status === "cancelled" ? "Cancelled" : s.status === "past_due" || s.due ? "Payment due" : "Active";
