/**
 * createQuietPay(): one configured client, with the billing model chosen at initialisation.
 *
 *   const qp = createQuietPay({ baseUrl, apiKey, merchantId, billing: "both" });
 *   await qp.createOrder({ amount: "8500000" });                       // one-time checkout
 *   const plan = await qp.subscriptions.createPlan({ name: "Pro", amount: "5000000", interval: "month" });
 *   const sub = await qp.subscriptions.subscribe({ planId: plan.id, customer: "cust_42" });
 *   const { order } = await qp.subscriptions.createRenewalOrder(sub.id); // send order.checkout to the subscriber
 *   qp.subscriptions.applyWebhook(event);                                 // a paid renewal advances the period
 *
 * billing: "one_time" (default) | "subscription" | "both". A method of a model that is off throws
 * QuietpayConfigError, so a subscription-only merchant cannot create stray one-time orders by mistake.
 *
 * How subscriptions work with gasless USDT: an EIP-3009 authorization moves one exact amount once, so nothing can pull
 * funds later. Each period the SDK creates a renewal order for the plan amount; the subscriber signs it (pay link,
 * email, in-app prompt), still with no gas. The renewal is marked paid only by a verified payment.settled webhook for
 * exactly that order and amount. An unpaid renewal makes the subscription past_due once its order expires.
 */
import type { Order } from "@quietpay/shared";
import type { WebhookEvent } from "@quietpay/shared/webhook";
import { createOrder, getOrder, listOrders, verifyWebhook, type VerifyWebhookOptions } from "./index.js";

type Hex = `0x${string}`;
export type BillingMode = "one_time" | "subscription" | "both";
export type Interval = "day" | "week" | "month" | "year";

export class QuietpayConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuietpayConfigError";
  }
}

export interface Plan {
  id: string;
  name: string;
  /** USDT base units per period. */
  amount: string;
  interval: Interval;
  /** Periods per charge, e.g. 3 with "month" for quarterly. Default 1. */
  intervalCount: number;
  createdAt: number;
}

export type SubscriptionStatus = "active" | "past_due" | "cancelled";

export interface Subscription {
  id: string;
  planId: string;
  /** Your customer reference (never an email is required; any id you use). */
  customer: string;
  status: SubscriptionStatus;
  /** Number of periods paid so far. */
  paidPeriods: number;
  /** Unix seconds when the next renewal is due. The first is due at subscribe time. */
  nextChargeAt: number;
  /** The open renewal order, if any. */
  pendingOrderId?: Hex;
  lastPaidOrderId?: Hex;
  lastPaidAt?: number;
  createdAt: number;
  cancelledAt?: number;
}

/** Where plans and subscriptions are kept. The default is in memory; give your database-backed one in production. */
export interface SubscriptionStore {
  getPlan(id: string): Plan | undefined | Promise<Plan | undefined>;
  putPlan(plan: Plan): void | Promise<void>;
  listPlans(): Plan[] | Promise<Plan[]>;
  getSubscription(id: string): Subscription | undefined | Promise<Subscription | undefined>;
  putSubscription(sub: Subscription): void | Promise<void>;
  listSubscriptions(): Subscription[] | Promise<Subscription[]>;
}

export function memorySubscriptionStore(): SubscriptionStore {
  const plans = new Map<string, Plan>();
  const subs = new Map<string, Subscription>();
  return {
    getPlan: (id) => (plans.has(id) ? { ...plans.get(id)! } : undefined),
    putPlan: (p) => void plans.set(p.id, { ...p }),
    listPlans: () => [...plans.values()].map((p) => ({ ...p })),
    getSubscription: (id) => (subs.has(id) ? { ...subs.get(id)! } : undefined),
    putSubscription: (s) => void subs.set(s.id, { ...s }),
    listSubscriptions: () => [...subs.values()].map((s) => ({ ...s })),
  };
}

export interface QuietPayConfig {
  baseUrl: string;
  /** Server side only. */
  apiKey: string;
  merchantId: Hex;
  /** Which billing models this merchant uses. Default "one_time". */
  billing?: BillingMode;
  webhookUrl?: string;
  /** Webhook secret, so applyWebhook/verifyWebhook can be called with the raw request. */
  webhookSecret?: string;
  subscriptionStore?: SubscriptionStore;
  /** Lifetime of a renewal order in seconds: the subscriber's window to pay. Default and maximum 86400 (the relayer's order limit). */
  renewalExpiresInSeconds?: number;
  fetch?: typeof fetch;
  /** Unix seconds; for tests. */
  now?: () => number;
}

const MODES: readonly BillingMode[] = ["one_time", "subscription", "both"];
const INTERVALS: readonly Interval[] = ["day", "week", "month", "year"];
const AMOUNT = /^[1-9]\d{0,30}$/;
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const REF = /^sub:([A-Za-z0-9_.:-]{1,64}):(\d{1,9})$/;

/** Next due time: calendar months/years clamp to the last day (Jan 31 + 1 month = Feb 28/29), UTC. */
export function addInterval(fromSeconds: number, interval: Interval, count = 1): number {
  if (interval === "day") return fromSeconds + 86400 * count;
  if (interval === "week") return fromSeconds + 7 * 86400 * count;
  const d = new Date(fromSeconds * 1000);
  const months = interval === "month" ? count : 12 * count;
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, last));
  return Math.floor(target.getTime() / 1000);
}

const randomId = (prefix: string) => {
  const b = new Uint8Array(12);
  globalThis.crypto.getRandomValues(b);
  return prefix + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
};

export function createQuietPay(config: QuietPayConfig) {
  const billing = config.billing ?? "one_time";
  if (!MODES.includes(billing)) throw new QuietpayConfigError(`billing must be one of ${MODES.join(", ")}`);
  if (!/^0x[0-9a-fA-F]{64}$/.test(config.merchantId)) throw new QuietpayConfigError("merchantId must be 0x + 64 hex characters");
  if (!config.apiKey) throw new QuietpayConfigError("apiKey is required");
  const oneTime = billing !== "subscription";
  const recurring = billing !== "one_time";
  const now = config.now ?? (() => Math.floor(Date.now() / 1000));
  const store = config.subscriptionStore ?? memorySubscriptionStore();
  const renewalTtl = config.renewalExpiresInSeconds ?? 86400;
  if (!Number.isInteger(renewalTtl) || renewalTtl < 60 || renewalTtl > 86400) throw new QuietpayConfigError("renewalExpiresInSeconds: 60-86400");
  const common = { baseUrl: config.baseUrl, apiKey: config.apiKey, ...(config.fetch ? { fetch: config.fetch } : {}) };
  const need = (on: boolean, what: string) => {
    if (!on) throw new QuietpayConfigError(`${what} is turned off: this client was created with billing "${billing}"`);
  };

  async function mustSub(id: string): Promise<Subscription> {
    const s = await store.getSubscription(id);
    if (!s) throw new QuietpayConfigError(`Unknown subscription ${id}`);
    return s;
  }

  const subscriptions = {
    async createPlan(p: { id?: string; name: string; amount: string; interval: Interval; intervalCount?: number }): Promise<Plan> {
      need(recurring, "Subscriptions");
      const id = p.id ?? randomId("plan_");
      if (!SAFE_ID.test(id)) throw new QuietpayConfigError("plan id: 1-64 of A-Z a-z 0-9 _ . : -");
      if (!p.name?.trim() || p.name.length > 80) throw new QuietpayConfigError("plan name: 1-80 characters");
      if (!AMOUNT.test(p.amount)) throw new QuietpayConfigError("plan amount: positive integer USDT base units, e.g. \"5000000\" for 5 USDT");
      if (!INTERVALS.includes(p.interval)) throw new QuietpayConfigError(`interval must be one of ${INTERVALS.join(", ")}`);
      const intervalCount = p.intervalCount ?? 1;
      if (!Number.isInteger(intervalCount) || intervalCount < 1 || intervalCount > 36) throw new QuietpayConfigError("intervalCount: 1-36");
      if (await store.getPlan(id)) throw new QuietpayConfigError(`Plan ${id} already exists`);
      const plan: Plan = { id, name: p.name.trim(), amount: p.amount, interval: p.interval, intervalCount, createdAt: now() };
      await store.putPlan(plan);
      return plan;
    },
    async listPlans() {
      need(recurring, "Subscriptions");
      return store.listPlans();
    },
    async subscribe(s: { planId: string; customer: string; id?: string }): Promise<Subscription> {
      need(recurring, "Subscriptions");
      if (!(await store.getPlan(s.planId))) throw new QuietpayConfigError(`Unknown plan ${s.planId}`);
      if (!s.customer || s.customer.length > 120) throw new QuietpayConfigError("customer: 1-120 characters");
      const id = s.id ?? randomId("sub_");
      if (!SAFE_ID.test(id)) throw new QuietpayConfigError("subscription id: 1-64 of A-Z a-z 0-9 _ . : -");
      if (await store.getSubscription(id)) throw new QuietpayConfigError(`Subscription ${id} already exists`);
      const t = now();
      const sub: Subscription = { id, planId: s.planId, customer: s.customer, status: "active", paidPeriods: 0, nextChargeAt: t, createdAt: t };
      await store.putSubscription(sub);
      return sub;
    },
    async get(id: string) {
      need(recurring, "Subscriptions");
      return store.getSubscription(id);
    },
    async list() {
      need(recurring, "Subscriptions");
      return store.listSubscriptions();
    },
    /** Active (or past_due) subscriptions whose renewal is due and that have no open renewal order. */
    async due(at = now()): Promise<Subscription[]> {
      need(recurring, "Subscriptions");
      return (await store.listSubscriptions()).filter((s) => s.status !== "cancelled" && s.nextChargeAt <= at && !s.pendingOrderId);
    },
    /**
     * Creates (or returns the still-open) renewal order for the current period. Idempotent per period: calling it
     * twice never creates two payable orders for the same period. Reference: "sub:<subscriptionId>:<period>".
     */
    async createRenewalOrder(id: string): Promise<{ subscription: Subscription; order: Order }> {
      need(recurring, "Subscriptions");
      let sub = await mustSub(id);
      if (sub.status === "cancelled") throw new QuietpayConfigError(`Subscription ${id} is cancelled`);
      const plan = await store.getPlan(sub.planId);
      if (!plan) throw new QuietpayConfigError(`Unknown plan ${sub.planId}`);
      if (sub.pendingOrderId) {
        const open = await getOrder({ baseUrl: config.baseUrl, orderId: sub.pendingOrderId, ...(config.fetch ? { fetch: config.fetch } : {}) });
        if (open.status === "created" || open.status === "pending") return { subscription: sub, order: open };
        if (open.status === "settled" || open.status === "partially_refunded" || open.status === "refunded") {
          // Paid but the webhook was missed: apply it now from the order itself.
          sub = await markPaid(sub, plan, open.id as Hex, open.settledAt ?? now());
          if (sub.nextChargeAt > now()) throw new QuietpayConfigError(`Subscription ${id} is paid until ${new Date(sub.nextChargeAt * 1000).toISOString()}`);
        } else {
          sub = { ...sub, pendingOrderId: undefined, status: "past_due" };
          await store.putSubscription(sub);
        }
      }
      if (sub.nextChargeAt > now()) throw new QuietpayConfigError(`Subscription ${id} is not due until ${new Date(sub.nextChargeAt * 1000).toISOString()}`);
      const order = await createOrder({
        ...common,
        merchantId: config.merchantId,
        amount: plan.amount,
        reference: `sub:${sub.id}:${sub.paidPeriods + 1}`,
        expiresInSeconds: renewalTtl,
        ...(config.webhookUrl ? { webhookUrl: config.webhookUrl } : {}),
      });
      sub = { ...sub, pendingOrderId: order.id as Hex };
      await store.putSubscription(sub);
      return { subscription: sub, order };
    },
    /**
     * Feeds a VERIFIED webhook event (from verifyWebhook) into the subscriptions. Returns the subscription it changed,
     * or undefined when the event is not about an open renewal. Matching is by the exact pending order id and the plan
     * amount; the reference alone is never trusted.
     */
    async applyWebhook(event: WebhookEvent): Promise<Subscription | undefined> {
      need(recurring, "Subscriptions");
      const m = REF.exec(event.data.reference ?? "");
      if (!m || event.data.merchantId.toLowerCase() !== config.merchantId.toLowerCase()) return undefined;
      const sub = await store.getSubscription(m[1]!);
      if (!sub || sub.pendingOrderId?.toLowerCase() !== event.data.orderId.toLowerCase()) return undefined;
      const plan = await store.getPlan(sub.planId);
      if (!plan) return undefined;
      if (event.type === "payment.settled") {
        if (event.data.amount !== plan.amount) return undefined;
        return markPaid(sub, plan, event.data.orderId as Hex, event.createdAt);
      }
      if (event.type === "payment.failed") {
        const next = { ...sub, pendingOrderId: undefined, status: sub.status === "cancelled" ? sub.status : ("past_due" as const) };
        await store.putSubscription(next);
        return next;
      }
      return undefined;
    },
    /** Verify + apply in one call, from the raw webhook request. Needs webhookSecret in the config. */
    async handleWebhook(raw: Omit<VerifyWebhookOptions, "secret">) {
      need(recurring, "Subscriptions");
      if (!config.webhookSecret) throw new QuietpayConfigError("webhookSecret is required for handleWebhook");
      const event = verifyWebhook({ ...raw, secret: config.webhookSecret });
      return { event, subscription: await subscriptions.applyWebhook(event) };
    },
    /** Stops future renewals. An already-open renewal order can still be paid; it is then recorded but nothing new is created. */
    async cancel(id: string): Promise<Subscription> {
      need(recurring, "Subscriptions");
      const sub = await mustSub(id);
      const next: Subscription = { ...sub, status: "cancelled", cancelledAt: sub.cancelledAt ?? now() };
      await store.putSubscription(next);
      return next;
    },
  };

  async function markPaid(sub: Subscription, plan: Plan, orderId: Hex, paidAt: number): Promise<Subscription> {
    const next: Subscription = {
      ...sub,
      status: sub.status === "cancelled" ? "cancelled" : "active",
      paidPeriods: sub.paidPeriods + 1,
      // Periods chain from the due date, not the pay date, so paying late does not shift the billing day.
      nextChargeAt: addInterval(Math.max(sub.nextChargeAt, sub.createdAt), plan.interval, plan.intervalCount),
      pendingOrderId: undefined,
      lastPaidOrderId: orderId,
      lastPaidAt: paidAt,
    };
    await store.putSubscription(next);
    return next;
  }

  return {
    billing,
    supports: { oneTime, subscription: recurring },
    /** One-time checkout order. Off when billing is "subscription". */
    createOrder(o: { amount: string; reference?: string; expiresInSeconds?: number }) {
      need(oneTime, "One-time payments");
      if (o.reference && REF.test(o.reference)) throw new QuietpayConfigError("References starting with sub: are reserved for subscription renewals");
      return createOrder({ ...common, merchantId: config.merchantId, ...o, ...(config.webhookUrl ? { webhookUrl: config.webhookUrl } : {}) });
    },
    getOrder: (orderId: string) => getOrder({ baseUrl: config.baseUrl, orderId, ...(config.fetch ? { fetch: config.fetch } : {}) }),
    listOrders: () => listOrders(common),
    verifyWebhook: (raw: Omit<VerifyWebhookOptions, "secret">) => {
      if (!config.webhookSecret) throw new QuietpayConfigError("webhookSecret is required");
      return verifyWebhook({ ...raw, secret: config.webhookSecret });
    },
    /** Present for every client; each method throws QuietpayConfigError unless billing includes subscriptions. */
    subscriptions,
  };
}

export type QuietPayClient = ReturnType<typeof createQuietPay>;
