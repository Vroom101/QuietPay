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
/** What you pass at init. "product" is another name for "one_time" (selling products / single payments). */
export type BillingOption = BillingMode | "product";
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
  /** Unix seconds the open renewal order expires (from the relayer), so due() can tell a live order from a dead one. */
  pendingExpiresAt?: number;
  /**
   * Every renewal order issued for the CURRENT unpaid period (max 20). The relayer can still settle a failed or
   * expired order late, so a payment.settled for any of them credits the period, exactly once.
   * Missing on subscriptions from an older store: treated as [pendingOrderId].
   */
  periodOrders?: Hex[];
  /** Orders that paid a period (last 50). A repeat webhook for one of these is ignored. */
  paidOrderIds?: Hex[];
  /** Orders issued for periods that are already paid (last 50), unpaid at the time. Settling one is a duplicate payment. */
  closedOrders?: Hex[];
  /** Orders that settled for a period that was already paid: the subscriber was charged twice. Refund these. */
  duplicatePayments?: { orderId: Hex; amount: string; at: number }[];
  /** First due date. Every later due date is anchorAt + k periods, so a month-end billing day never drifts. Missing: createdAt. */
  anchorAt?: number;
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
  /**
   * OPTIONAL atomic write: store `next` only if the stored subscription still equals `prev` (compare every field, or a
   * version column); return false when it changed. The SDK serialises calls per subscription inside ONE process only
   * (an in-memory lock). With several processes/servers sharing a database you MUST implement this, or two workers can
   * still create two payable orders for one period. When present the SDK uses it for every write and retries on false.
   */
  compareAndSetSubscription?(prev: Subscription, next: Subscription): boolean | Promise<boolean>;
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

export type PaymentLinkStatus = "active" | "paid" | "deactivated";

/** A reusable (or single-use) pay page: each customer visit gets a fresh checkout order for the same amount. */
export interface PaymentLink {
  id: string;
  /** 1-80 characters. */
  title: string;
  /** At most 280 characters. */
  description?: string;
  /** USDT base units, positive integer. */
  amount: string;
  singleUse: boolean;
  status: PaymentLinkStatus;
  /** Verified payments credited to this link. */
  paidCount: number;
  /** Unix seconds; checkout is refused from this moment on. */
  expiresAt?: number;
  createdAt: number;
  /** Checkout orders issued for this link (last 50). Only these can credit it. */
  orderIds: string[];
  /** Orders that were credited (last 50). A repeat webhook for one of these is ignored. */
  paidOrderIds: string[];
  lastPaidOrderId?: string;
  lastPaidAt?: number;
  /** Orders that settled after a single-use link was already paid: the customer paid twice. Refund these. */
  duplicatePayments?: string[];
}

/** Where payment links are kept. The default is in memory; give your database-backed one in production. */
export interface PaymentLinkStore {
  getLink(id: string): PaymentLink | undefined | Promise<PaymentLink | undefined>;
  putLink(link: PaymentLink): void | Promise<void>;
  listLinks(): PaymentLink[] | Promise<PaymentLink[]>;
  /** OPTIONAL atomic write (see SubscriptionStore.compareAndSetSubscription): store `next` only if the stored link still equals `prev`. Required when several processes share a database. */
  compareAndSetLink?(prev: PaymentLink, next: PaymentLink): boolean | Promise<boolean>;
}

const cloneLink = (l: PaymentLink): PaymentLink => ({ ...l, orderIds: [...l.orderIds], paidOrderIds: [...l.paidOrderIds], ...(l.duplicatePayments ? { duplicatePayments: [...l.duplicatePayments] } : {}) });

export function memoryPaymentLinkStore(): PaymentLinkStore {
  const links = new Map<string, PaymentLink>();
  return {
    getLink: (id) => (links.has(id) ? cloneLink(links.get(id)!) : undefined),
    putLink: (l) => void links.set(l.id, cloneLink(l)),
    listLinks: () => [...links.values()].map(cloneLink),
  };
}

export interface QuietPayConfig {
  baseUrl: string;
  /** Server side only. */
  apiKey: string;
  merchantId: Hex;
  /** Which billing models this merchant uses. Default "one_time". */
  billing?: BillingOption;
  webhookUrl?: string;
  /** Webhook secret, so applyWebhook/verifyWebhook can be called with the raw request. */
  webhookSecret?: string;
  subscriptionStore?: SubscriptionStore;
  /** Lifetime of a renewal order in seconds: the subscriber's window to pay. Default and maximum 86400 (the relayer's order limit). */
  renewalExpiresInSeconds?: number;
  paymentLinkStore?: PaymentLinkStore;
  /** Lifetime of a payment-link checkout order in seconds. Default 1800, 60..86400. */
  linkCheckoutExpiresInSeconds?: number;
  fetch?: typeof fetch;
  /** Unix seconds; for tests. */
  now?: () => number;
}

const MODES: readonly BillingMode[] = ["one_time", "subscription", "both"];
const INTERVALS: readonly Interval[] = ["day", "week", "month", "year"];
const AMOUNT = /^[1-9]\d{0,30}$/;
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const REF = /^sub:([A-Za-z0-9_.:-]{1,64}):(\d{1,9})$/;
const LINK_REF = /^link:([A-Za-z0-9_.:-]{1,64}):(\d{1,9})$/;
const MAX_LINK_EXPIRY = 90 * 86400;
const MAX_PERIOD_ORDERS = 20;
const MAX_HISTORY = 50;
const CAS_RETRIES = 5;
const low = (s: string) => s.toLowerCase();
const has = (list: readonly string[] | undefined, id: string) => !!list?.some((x) => low(x) === low(id));
const tail = <T>(list: T[]): T[] => list.slice(-MAX_HISTORY);
/** Every renewal order issued for the current unpaid period (old stores: just the pending one). */
const periodOrdersOf = (s: Subscription): Hex[] => s.periodOrders ?? (s.pendingOrderId ? [s.pendingOrderId] : []);

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
  const chosen = config.billing ?? "one_time";
  const billing: BillingMode = chosen === "product" ? "one_time" : chosen;
  if (!MODES.includes(billing)) throw new QuietpayConfigError(`billing must be one of product (same as one_time), ${MODES.join(", ")}`);
  if (!/^0x[0-9a-fA-F]{64}$/.test(config.merchantId)) throw new QuietpayConfigError("merchantId must be 0x + 64 hex characters");
  if (!config.apiKey) throw new QuietpayConfigError("apiKey is required");
  const oneTime = billing !== "subscription";
  const recurring = billing !== "one_time";
  const now = config.now ?? (() => Math.floor(Date.now() / 1000));
  const store = config.subscriptionStore ?? memorySubscriptionStore();
  const renewalTtl = config.renewalExpiresInSeconds ?? 86400;
  if (!Number.isInteger(renewalTtl) || renewalTtl < 60 || renewalTtl > 86400) throw new QuietpayConfigError("renewalExpiresInSeconds: 60-86400");
  const linkStore = config.paymentLinkStore ?? memoryPaymentLinkStore();
  const linkTtl = config.linkCheckoutExpiresInSeconds ?? 1800;
  if (!Number.isInteger(linkTtl) || linkTtl < 60 || linkTtl > 86400) throw new QuietpayConfigError("linkCheckoutExpiresInSeconds: 60-86400");
  const common = { baseUrl: config.baseUrl, apiKey: config.apiKey, ...(config.fetch ? { fetch: config.fetch } : {}) };
  const need = (on: boolean, what: string) => {
    if (!on) throw new QuietpayConfigError(`${what} is turned off: this client was created with billing "${billing}"`);
  };

  async function mustSub(id: string): Promise<Subscription> {
    const s = await store.getSubscription(id);
    if (!s) throw new QuietpayConfigError(`Unknown subscription ${id}`);
    return s;
  }

  // In-process, per-subscription serialisation (promise chain). Multi-process deployments need
  // SubscriptionStore.compareAndSetSubscription as well: this lock cannot see other processes.
  const locks = new Map<string, Promise<unknown>>();
  async function locked<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(id) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const end = run.catch(() => undefined);
    locks.set(id, end);
    try {
      return await run;
    } finally {
      if (locks.get(id) === end) locks.delete(id);
    }
  }

  /** Read-modify-write one subscription. fn returns the new value, or undefined for "no change". Uses compare-and-set when the store has it. */
  async function update(id: string, fn: (cur: Subscription) => Subscription | undefined): Promise<Subscription | undefined> {
    for (let i = 0; i < CAS_RETRIES; i++) {
      const cur = await store.getSubscription(id);
      if (!cur) return undefined;
      const next = fn(cur);
      if (!next) return cur;
      if (!store.compareAndSetSubscription) {
        await store.putSubscription(next);
        return next;
      }
      if (await store.compareAndSetSubscription(cur, next)) return next;
    }
    throw new QuietpayConfigError(`Subscription ${id} is being changed concurrently; try again`);
  }

  const creditPeriod = (sub: Subscription, plan: Plan, orderId: Hex, paidAt: number): Subscription => {
    const periods = sub.paidPeriods + 1;
    return {
      ...sub,
      status: sub.status === "cancelled" ? "cancelled" : "active",
      paidPeriods: periods,
      // Every due date is anchor + k periods (not previous due + 1 period), so Jan 31 -> Feb 28 -> Mar 31 and paying late never shifts the day.
      nextChargeAt: addInterval(sub.anchorAt ?? sub.createdAt, plan.interval, plan.intervalCount * periods),
      pendingOrderId: undefined,
      pendingExpiresAt: undefined,
      periodOrders: [],
      paidOrderIds: tail([...(sub.paidOrderIds ?? []), orderId]),
      closedOrders: tail([...(sub.closedOrders ?? []), ...periodOrdersOf(sub).filter((x) => low(x) !== low(orderId))]),
      lastPaidOrderId: orderId,
      lastPaidAt: paidAt,
    };
  };
  const withDuplicate = (sub: Subscription, orderId: Hex, amount: string, at: number): Subscription | undefined =>
    sub.duplicatePayments?.some((d) => low(d.orderId) === low(orderId))
      ? undefined
      : { ...sub, duplicatePayments: tail([...(sub.duplicatePayments ?? []), { orderId, amount, at }]) };
  const markFailed = (sub: Subscription, orderId: string): Subscription => {
    const pendingGone = !!sub.pendingOrderId && low(sub.pendingOrderId) === low(orderId);
    return {
      ...sub,
      status: sub.status === "cancelled" ? "cancelled" : "past_due",
      periodOrders: periodOrdersOf(sub), // advisory only: a late attempt may still settle, so keep every id
      ...(pendingGone ? { pendingOrderId: undefined, pendingExpiresAt: undefined } : {}),
    };
  };
  const goodSettled = (o: Order, plan: Plan) => o.status === "settled" && o.amount === plan.amount && low(o.merchantId) === low(config.merchantId);
  const readOrder = (orderId: string) => getOrder({ baseUrl: config.baseUrl, orderId, ...(config.fetch ? { fetch: config.fetch } : {}) });

  /** Re-reads every order issued for the current period: credits a settled one, finds a still-open one, else marks past_due. */
  async function reconcile(sub: Subscription, plan: Plan): Promise<{ sub: Subscription; open?: Order }> {
    const ids = periodOrdersOf(sub);
    if (!ids.length) return { sub };
    const fetched: Order[] = [];
    for (const id of [...ids].reverse()) fetched.push(await readOrder(id));
    const winner = fetched.find((o) => goodSettled(o, plan));
    if (winner) {
      let next = await update(sub.id, (cur) => (has(periodOrdersOf(cur), winner.id) ? creditPeriod(cur, plan, winner.id as Hex, winner.settledAt ?? now()) : undefined));
      for (const o of fetched) {
        if (o !== winner && goodSettled(o, plan)) next = (await update(sub.id, (cur) => withDuplicate(cur, o.id as Hex, o.amount, now()))) ?? next;
      }
      return { sub: next ?? sub };
    }
    const open = fetched.find((o) => o.status === "created" || o.status === "pending");
    if (open) {
      if (sub.pendingOrderId && low(sub.pendingOrderId) === low(open.id)) return { sub, open };
      const next = await update(sub.id, (cur) => ({ ...cur, pendingOrderId: open.id as Hex, pendingExpiresAt: open.expiresAt }));
      return { sub: next ?? sub, open };
    }
    if (sub.status === "past_due" && !sub.pendingOrderId) return { sub };
    const next = await update(sub.id, (cur) => ({
      ...cur,
      status: cur.status === "cancelled" ? "cancelled" : "past_due",
      periodOrders: periodOrdersOf(cur),
      pendingOrderId: undefined,
      pendingExpiresAt: undefined,
    }));
    return { sub: next ?? sub };
  }

  async function renewalOrder(id: string): Promise<{ subscription: Subscription; order: Order }> {
    let sub = await mustSub(id);
    if (sub.status === "cancelled") throw new QuietpayConfigError(`Subscription ${id} is cancelled`);
    const plan = await store.getPlan(sub.planId);
    if (!plan) throw new QuietpayConfigError(`Unknown plan ${sub.planId}`);
    const before = sub.paidPeriods;
    const r = await reconcile(sub, plan); // missed webhooks: credit a settled order from the order itself
    sub = r.sub;
    if (r.open) return { subscription: sub, order: r.open };
    if (sub.nextChargeAt > now()) throw new QuietpayConfigError(`Subscription ${id} is ${sub.paidPeriods > before ? "paid until" : "not due until"} ${new Date(sub.nextChargeAt * 1000).toISOString()}`);
    if (periodOrdersOf(sub).length >= MAX_PERIOD_ORDERS) throw new QuietpayConfigError(`Subscription ${id}: too many unpaid renewal orders for this period (${MAX_PERIOD_ORDERS})`);
    const periodAtCreate = sub.paidPeriods;
    const order = await createOrder({
      ...common,
      merchantId: config.merchantId,
      amount: plan.amount,
      reference: `sub:${sub.id}:${sub.paidPeriods + 1}`,
      expiresInSeconds: renewalTtl,
      ...(config.webhookUrl ? { webhookUrl: config.webhookUrl } : {}),
    });
    const next = await update(sub.id, (cur) => {
      if (cur.paidPeriods !== periodAtCreate) throw new QuietpayConfigError(`Subscription ${id} changed while its renewal order was being created (order ${order.id} was issued for the previous period)`);
      return { ...cur, pendingOrderId: order.id as Hex, pendingExpiresAt: order.expiresAt, periodOrders: [...periodOrdersOf(cur).filter((x) => low(x) !== low(order.id)), order.id as Hex] };
    });
    return { subscription: next ?? sub, order };
  }

  async function applyEvent(event: WebhookEvent): Promise<Subscription | undefined> {
    const m = REF.exec(event.data.reference ?? "");
    if (!m || low(event.data.merchantId) !== low(config.merchantId)) return undefined;
    const sub = await store.getSubscription(m[1]!);
    if (!sub) return undefined;
    const plan = await store.getPlan(sub.planId);
    if (!plan) return undefined;
    const orderId = event.data.orderId as Hex;
    const current = has(periodOrdersOf(sub), orderId);
    if (event.type === "payment.settled") {
      if (event.data.amount !== plan.amount) return undefined;
      if (current) return update(sub.id, (cur) => (has(periodOrdersOf(cur), orderId) ? creditPeriod(cur, plan, orderId, event.createdAt) : undefined));
      if (has(sub.paidOrderIds, orderId) || (sub.lastPaidOrderId && low(sub.lastPaidOrderId) === low(orderId))) return undefined; // replay of the credited webhook
      if (has(sub.closedOrders, orderId)) return update(sub.id, (cur) => withDuplicate(cur, orderId, event.data.amount, event.createdAt)); // paid twice: refund this one
      return undefined;
    }
    if (event.type === "payment.failed" && current) return update(sub.id, (cur) => markFailed(cur, orderId));
    return undefined;
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
      const sub: Subscription = { id, planId: s.planId, customer: s.customer, status: "active", paidPeriods: 0, nextChargeAt: t, createdAt: t, anchorAt: t, periodOrders: [] };
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
    /**
     * Subscriptions that need a (new) renewal order: not cancelled, nextChargeAt <= at, and either no open order or an
     * open order that has expired. A cron should call sweep() first (it re-reads pending orders and settles or
     * past_dues them), then due(), then createRenewalOrder() for each.
     */
    async due(at = now()): Promise<Subscription[]> {
      need(recurring, "Subscriptions");
      return (await store.listSubscriptions()).filter(
        (s) => s.status !== "cancelled" && s.nextChargeAt <= at && (!s.pendingOrderId || s.pendingExpiresAt === undefined || s.pendingExpiresAt <= at),
      );
    },
    /**
     * Reconciles every overdue subscription that has unpaid renewal orders against the relayer: a settled order credits
     * the period, expired/failed ones make it past_due (their ids are kept in case a late attempt settles). Returns the
     * subscriptions it looked at, as they are afterwards.
     */
    async sweep(at = now()): Promise<Subscription[]> {
      need(recurring, "Subscriptions");
      const out: Subscription[] = [];
      for (const s of await store.listSubscriptions()) {
        if (s.status === "cancelled" || s.nextChargeAt > at || !periodOrdersOf(s).length) continue;
        out.push(
          await locked(s.id, async () => {
            const cur = await store.getSubscription(s.id);
            const plan = cur && (await store.getPlan(cur.planId));
            return cur && plan ? (await reconcile(cur, plan)).sub : s;
          }),
        );
      }
      return out;
    },
    /**
     * Creates (or returns the still-open) renewal order for the current period. Idempotent per period, also under
     * concurrent calls in this process: calling it twice never creates two payable orders for the same period.
     * Reference: "sub:<subscriptionId>:<period>". Several processes need a store with compareAndSetSubscription.
     */
    createRenewalOrder(id: string): Promise<{ subscription: Subscription; order: Order }> {
      need(recurring, "Subscriptions");
      return locked(id, () => renewalOrder(id));
    },
    /**
     * Feeds a VERIFIED webhook event (from verifyWebhook) into the subscriptions. Returns the subscription it changed,
     * or undefined when the event is not about a renewal order of this subscription's current period. A payment.settled
     * for ANY order issued for the unpaid period (exact plan amount, this merchant) credits it exactly once; settling a
     * second order of an already-paid period is recorded in subscription.duplicatePayments (refund it) and not credited.
     * payment.failed is advisory (past_due): the order ids are kept because a late attempt can still settle.
     */
    async applyWebhook(event: WebhookEvent): Promise<Subscription | undefined> {
      need(recurring, "Subscriptions");
      const m = REF.exec(event.data.reference ?? "");
      if (!m) return undefined;
      return locked(m[1]!, () => applyEvent(event));
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
      return locked(id, async () => {
        await mustSub(id);
        return (await update(id, (cur) => ({ ...cur, status: "cancelled", cancelledAt: cur.cancelledAt ?? now() })))!;
      });
    },
  };

  /** Read-modify-write one link; fn returns the new value or undefined for "no change". Uses compare-and-set when the store has it. */
  async function updateLink(id: string, fn: (cur: PaymentLink) => PaymentLink | undefined): Promise<PaymentLink | undefined> {
    for (let i = 0; i < CAS_RETRIES; i++) {
      const cur = await linkStore.getLink(id);
      if (!cur) return undefined;
      const next = fn(cur);
      if (!next) return cur;
      if (!linkStore.compareAndSetLink) {
        await linkStore.putLink(next);
        return next;
      }
      if (await linkStore.compareAndSetLink(cur, next)) return next;
    }
    throw new QuietpayConfigError(`Payment link ${id} is being changed concurrently; try again`);
  }
  const lockLink = <T>(id: string, fn: () => Promise<T>) => locked(`link:${id}`, fn);
  async function mustLink(id: string): Promise<PaymentLink> {
    const l = await linkStore.getLink(id);
    if (!l) throw new QuietpayConfigError(`Unknown payment link ${id}`);
    return l;
  }

  async function applyLinkEvent(event: WebhookEvent): Promise<PaymentLink | undefined> {
    const m = LINK_REF.exec(event.data.reference ?? "");
    if (!m || event.type !== "payment.settled" || low(event.data.merchantId) !== low(config.merchantId)) return undefined;
    const link = await linkStore.getLink(m[1]!);
    if (!link || !has(link.orderIds, event.data.orderId) || event.data.amount !== link.amount) return undefined;
    const orderId = event.data.orderId;
    if (has(link.paidOrderIds, orderId) || has(link.duplicatePayments, orderId)) return undefined; // replay
    return updateLink(link.id, (cur) => {
      if (!has(cur.orderIds, orderId) || has(cur.paidOrderIds, orderId) || has(cur.duplicatePayments, orderId)) return undefined;
      if (cur.singleUse && cur.paidCount > 0) return { ...cur, duplicatePayments: tail([...(cur.duplicatePayments ?? []), orderId]) };
      return {
        ...cur,
        paidCount: cur.paidCount + 1,
        paidOrderIds: tail([...cur.paidOrderIds, orderId]),
        lastPaidOrderId: orderId,
        lastPaidAt: event.createdAt,
        status: cur.singleUse && cur.status === "active" ? "paid" : cur.status,
      };
    });
  }

  const links = {
    async create(p: { title: string; amount: string; description?: string; singleUse?: boolean; expiresInSeconds?: number; id?: string }): Promise<PaymentLink> {
      need(oneTime, "Payment links");
      const id = p.id ?? randomId("link_");
      if (!SAFE_ID.test(id)) throw new QuietpayConfigError("link id: 1-64 of A-Z a-z 0-9 _ . : -");
      const title = typeof p.title === "string" ? p.title.trim() : "";
      if (!title || title.length > 80) throw new QuietpayConfigError("link title: 1-80 characters");
      if (typeof p.amount !== "string" || !AMOUNT.test(p.amount)) throw new QuietpayConfigError("link amount: positive integer USDT base units, e.g. \"5000000\" for 5 USDT");
      const description = p.description?.trim();
      if (p.description !== undefined && (typeof p.description !== "string" || p.description.length > 280)) throw new QuietpayConfigError("link description: at most 280 characters");
      if (p.singleUse !== undefined && typeof p.singleUse !== "boolean") throw new QuietpayConfigError("singleUse must be a boolean");
      if (p.expiresInSeconds !== undefined && (!Number.isInteger(p.expiresInSeconds) || p.expiresInSeconds < 60 || p.expiresInSeconds > MAX_LINK_EXPIRY)) throw new QuietpayConfigError("link expiresInSeconds: 60 to 90 days");
      if (await linkStore.getLink(id)) throw new QuietpayConfigError(`Payment link ${id} already exists`);
      const t = now();
      const link: PaymentLink = {
        id, title, ...(description ? { description } : {}), amount: p.amount, singleUse: p.singleUse ?? true, status: "active", paidCount: 0,
        ...(p.expiresInSeconds !== undefined ? { expiresAt: t + p.expiresInSeconds } : {}), createdAt: t, orderIds: [], paidOrderIds: [],
      };
      await linkStore.putLink(link);
      return link;
    },
    async get(id: string): Promise<PaymentLink | undefined> {
      need(oneTime, "Payment links");
      return linkStore.getLink(id);
    },
    /** Newest first. */
    async list(): Promise<PaymentLink[]> {
      need(oneTime, "Payment links");
      return [...(await linkStore.listLinks())].sort((a, b) => b.createdAt - a.createdAt);
    },
    /** Stops new checkouts. Orders already issued can still be paid and are still credited. */
    async deactivate(id: string): Promise<PaymentLink> {
      need(oneTime, "Payment links");
      return lockLink(id, async () => {
        await mustLink(id);
        return (await updateLink(id, (cur) => (cur.status === "deactivated" ? undefined : { ...cur, status: "deactivated" })))!;
      });
    },
    /**
     * Opens a checkout order for the link amount. Several open orders per link are fine (customers retry); only a
     * verified payment.settled for one of them credits the link. Reference: "link:<id>:<n>".
     */
    async checkout(id: string): Promise<{ link: PaymentLink; order: Order }> {
      need(oneTime, "Payment links");
      return lockLink(id, async () => {
        const link = await mustLink(id);
        if (link.status === "deactivated") throw new QuietpayConfigError(`Payment link ${id} is deactivated`);
        if (link.singleUse && (link.status === "paid" || link.paidCount > 0)) throw new QuietpayConfigError(`Payment link ${id} is single-use and has already been paid`);
        if (link.expiresAt !== undefined && now() >= link.expiresAt) throw new QuietpayConfigError(`Payment link ${id} has expired`);
        const order = await createOrder({
          ...common,
          merchantId: config.merchantId,
          amount: link.amount,
          reference: `link:${link.id}:${link.orderIds.length + 1}`,
          expiresInSeconds: linkTtl,
          ...(config.webhookUrl ? { webhookUrl: config.webhookUrl } : {}),
        });
        const next = await updateLink(id, (cur) => ({ ...cur, orderIds: tail([...cur.orderIds.filter((x) => low(x) !== low(order.id)), order.id]) }));
        return { link: next ?? link, order };
      });
    },
    /** Feeds a VERIFIED webhook event in. Returns the link it changed (credited or duplicate recorded), else undefined. */
    async applyWebhook(event: WebhookEvent): Promise<PaymentLink | undefined> {
      need(oneTime, "Payment links");
      const m = LINK_REF.exec(event.data.reference ?? "");
      if (!m) return undefined;
      return lockLink(m[1]!, () => applyLinkEvent(event));
    },
    /** Verify + apply to subscriptions and links from the raw webhook request. Needs webhookSecret. */
    async handleWebhook(raw: Omit<VerifyWebhookOptions, "secret">) {
      if (!config.webhookSecret) throw new QuietpayConfigError("webhookSecret is required for handleWebhook");
      const event = verifyWebhook({ ...raw, secret: config.webhookSecret });
      return {
        event,
        subscription: recurring ? await subscriptions.applyWebhook(event) : undefined,
        link: oneTime ? await links.applyWebhook(event) : undefined,
      };
    },
  };

  return {
    billing,
    supports: { oneTime, subscription: recurring },
    /** One-time checkout order. Off when billing is "subscription". */
    createOrder(o: { amount: string; reference?: string; expiresInSeconds?: number }) {
      need(oneTime, "One-time payments");
      if (o.reference && REF.test(o.reference)) throw new QuietpayConfigError("References starting with sub: are reserved for subscription renewals");
      if (o.reference && LINK_REF.test(o.reference)) throw new QuietpayConfigError("References starting with link: are reserved for payment links");
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
    /** Payment links; each method throws QuietpayConfigError unless billing includes one-time payments. */
    links,
  };
}

export type QuietPayClient = ReturnType<typeof createQuietPay>;
