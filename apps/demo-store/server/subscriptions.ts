/**
 * Real (gasless USDT) subscriptions for the store server, on top of the merchant SDK's createQuietPay().
 *
 * An EIP-3009 authorization moves one exact amount once, so each period is a fresh renewal order that the subscriber
 * signs. A period counts as paid only when a verified payment.settled webhook (re-read from the relayer by app.ts)
 * names exactly the open renewal order for the plan amount. See packages/merchant-sdk/src/client.ts.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import * as realSdk from "@quietpay/merchant-sdk";
import type { Order } from "@quietpay/shared";
import { formatUsdt, parseUsdt, ORDER_TOKEN_HEADER } from "@quietpay/shared";
import type { WebhookEvent } from "@quietpay/shared/webhook";
import { setPrivateHeaders } from "./customer-refund-routes.js";
import { merchantAuthorized } from "./ledger-proxy.js";

export type BillingMode = "one_time" | "subscription" | "both";
type Plan = realSdk.Plan;
type Subscription = realSdk.Subscription;
type SubscriptionStore = realSdk.SubscriptionStore;
type Client = ReturnType<typeof realSdk.createQuietPay>;

export interface PlanView {
  id: string;
  name: string;
  amount: string;
  amountBase: string;
  interval: "day" | "week" | "month" | "year";
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

export interface SubscriptionsOptions {
  baseUrl: string;
  apiKey: string;
  merchantId: `0x${string}`;
  payout?: `0x${string}`;
  webhookUrl?: string;
  billing?: BillingMode;
  subscriptionsFile?: string;
  dashboardToken?: string;
  acceptSession?: (token: string) => boolean;
  /** SDK module (or a test stub). Its createQuietPay is used when present. */
  sdk: { createQuietPay?: typeof realSdk.createQuietPay };
  /** Test hook: fake relayer fetch for the subscription client. */
  fetch?: typeof fetch;
  /** Order-creating routes (subscribe, renew). */
  limiter: { allow(ip: string): boolean };
  /** Read routes. */
  readLimiter: { allow(ip: string): boolean };
  customer: { issueToken(order: Order): string; hasOrder(id: string): boolean };
  log: { error(...args: unknown[]): void };
}

interface Persisted {
  plans: Plan[];
  subscriptions: Subscription[];
}

/** In-memory store, persisted to a JSON file (temp file + rename) after every write when a path is given. */
export function jsonFileSubscriptionStore(file?: string): SubscriptionStore {
  const plans = new Map<string, Plan>();
  const subs = new Map<string, Subscription>();
  if (file) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<Persisted>;
      for (const p of parsed.plans ?? []) plans.set(p.id, p);
      for (const s of parsed.subscriptions ?? []) subs.set(s.id, s);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  const save = () => {
    if (!file) return;
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ plans: [...plans.values()], subscriptions: [...subs.values()] } satisfies Persisted));
    renameSync(tmp, file);
  };
  return {
    getPlan: (id) => (plans.has(id) ? { ...plans.get(id)! } : undefined),
    putPlan: (p) => { plans.set(p.id, { ...p }); save(); },
    listPlans: () => [...plans.values()].map((p) => ({ ...p })),
    getSubscription: (id) => (subs.has(id) ? { ...subs.get(id)! } : undefined),
    putSubscription: (s) => { subs.set(s.id, { ...s }); save(); },
    listSubscriptions: () => [...subs.values()].map((s) => ({ ...s })),
  };
}

const SAFE_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const INTERVALS = ["day", "week", "month", "year"] as const;
const OFF = { error: "Subscriptions are not enabled for this store." };
const iso = (sec: number) => new Date(sec * 1000).toISOString();

export function registerSubscriptions(app: FastifyInstance, opts: SubscriptionsOptions) {
  const billing = opts.billing ?? "both";
  const enabled = billing !== "one_time";
  const merchantId = opts.merchantId.toLowerCase();
  const nowSec = () => Math.floor(Date.now() / 1000);

  let client: Client | undefined;
  if (enabled) {
    const make = opts.sdk.createQuietPay ?? realSdk.createQuietPay;
    client = make({
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      merchantId: opts.merchantId,
      billing,
      ...(opts.webhookUrl ? { webhookUrl: opts.webhookUrl } : {}),
      subscriptionStore: jsonFileSubscriptionStore(opts.subscriptionsFile),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
  }
  const subs = () => client!.subscriptions;

  const planView = (p: Plan): PlanView => ({
    id: p.id, name: p.name, amount: formatUsdt(p.amount), amountBase: p.amount, interval: p.interval, intervalCount: p.intervalCount,
  });
  async function view(s: Subscription): Promise<SubscriptionView | undefined> {
    const plan = (await subs().listPlans()).find((p) => p.id === s.planId);
    if (!plan) return undefined;
    return {
      id: s.id,
      plan: planView(plan),
      status: s.status,
      paidPeriods: s.paidPeriods,
      nextCharge: s.status === "cancelled" ? null : iso(s.nextChargeAt),
      due: s.status !== "cancelled" && s.nextChargeAt <= nowSec(),
      ...(s.pendingOrderId ? { pendingOrderId: s.pendingOrderId } : {}),
      ...(s.lastPaidOrderId ? { lastPaidOrderId: s.lastPaidOrderId } : {}),
    };
  }

  // One renewal at a time per subscription so concurrent calls cannot create two payable orders.
  const locks = new Map<string, Promise<unknown>>();
  async function locked<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(id) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    locks.set(id, tail);
    try {
      return await run;
    } finally {
      if (locks.get(id) === tail) locks.delete(id);
    }
  }

  const off = (reply: FastifyReply) => (enabled ? false : (reply.code(503).send(OFF), true));
  const merchantGate = (req: { headers: { authorization?: string } }, reply: FastifyReply): boolean => {
    reply.header("cache-control", "no-store");
    if (off(reply)) return false;
    if (!merchantAuthorized(req.headers.authorization, { dashboardToken: opts.dashboardToken, acceptSession: opts.acceptSession })) {
      reply.code(401).send({ error: "Dashboard access token was not accepted." });
      return false;
    }
    return true;
  };
  const publicGate = (ip: string, reply: FastifyReply, limiter: { allow(ip: string): boolean }): boolean => {
    if (off(reply)) return false;
    if (!limiter.allow(ip)) {
      reply.code(429).send({ error: "too many requests, try again shortly" });
      return false;
    }
    return true;
  };

  /** Only hand the browser an order that is exactly what this store asked for (same rule as /api/checkout). */
  function checkOrder(order: Order, plan: Plan): string | undefined {
    const payout = opts.payout ?? order.payout;
    if (
      order.merchantId.toLowerCase() !== merchantId ||
      order.amount !== plan.amount ||
      order.payout.toLowerCase() !== payout.toLowerCase()
    ) return undefined;
    return payout;
  }
  function checkout(order: Order, payout: string, reply: FastifyReply) {
    setPrivateHeaders(reply);
    // The status token is shown once; an order that already has one (re-opened renewal) cannot be given another.
    if (!opts.customer.hasOrder(order.id)) reply.header(ORDER_TOKEN_HEADER, opts.customer.issueToken(order));
    return { orderId: order.id, amount: formatUsdt(order.amount), payout };
  }
  const BAD_ORDER = { error: "could not start subscription checkout" };

  // ---- merchant routes ----
  app.get("/api/merchant/plans", async (req, reply) => {
    if (!merchantGate(req, reply)) return reply;
    const plans = (await subs().listPlans()).map((p, i) => ({ p, i }));
    plans.sort((a, b) => b.p.createdAt - a.p.createdAt || b.i - a.i);
    return { plans: plans.map((x) => planView(x.p)) };
  });

  app.post("/api/merchant/plans", async (req, reply) => {
    if (!merchantGate(req, reply)) return reply;
    const b = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
    const bad = (error: string) => reply.code(400).send({ error });
    if (typeof b.name !== "string" || !b.name.trim() || b.name.length > 80) return bad("name must be 1-80 characters");
    let base: bigint;
    try {
      if (typeof b.amount !== "string") throw new Error();
      base = parseUsdt(b.amount);
    } catch {
      return bad('amount must be a positive USDT amount with at most 6 decimals, e.g. "5.00"');
    }
    if (typeof b.interval !== "string" || !(INTERVALS as readonly string[]).includes(b.interval)) return bad("interval must be day, week, month or year");
    const count = b.intervalCount ?? 1;
    if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > 36) return bad("intervalCount must be a whole number from 1 to 36");
    try {
      const plan = await subs().createPlan({ name: b.name, amount: base.toString(), interval: b.interval as Plan["interval"], intervalCount: count });
      return reply.code(201).send(planView(plan));
    } catch (e) {
      if (e instanceof realSdk.QuietpayConfigError) return bad(e.message);
      throw e;
    }
  });

  app.get("/api/merchant/subscriptions", async (req, reply) => {
    if (!merchantGate(req, reply)) return reply;
    const out = [];
    for (const s of await subs().list()) {
      const v = await view(s);
      if (v) out.push({ ...v, customer: s.customer, createdAt: iso(s.createdAt), _t: s.createdAt });
    }
    out.sort((a, b) => b._t - a._t);
    return { subscriptions: out.map(({ _t, ...rest }) => rest) };
  });

  // ---- customer routes ----
  const idOk = (id: string) => SAFE_ID.test(id);

  app.get<{ Params: { id: string } }>("/api/plans/:id", async (req, reply) => {
    if (!publicGate(req.ip, reply, opts.readLimiter)) return reply;
    const plan = idOk(req.params.id) ? await subs().listPlans().then((l) => l.find((p) => p.id === req.params.id)) : undefined;
    return plan ? planView(plan) : reply.code(404).send({ error: "Plan not found." });
  });

  app.post<{ Params: { id: string } }>("/api/plans/:id/subscribe", async (req, reply) => {
    if (!publicGate(req.ip, reply, opts.limiter)) return reply;
    const plan = idOk(req.params.id) ? await subs().listPlans().then((l) => l.find((p) => p.id === req.params.id)) : undefined;
    if (!plan) return reply.code(404).send({ error: "Plan not found." });
    if ((req.body as { consent?: unknown } | null | undefined)?.consent !== true) {
      return reply.code(400).send({ error: "You must agree to the recurring payments to subscribe." });
    }
    let sub: Subscription | undefined;
    try {
      sub = await subs().subscribe({ planId: plan.id, customer: "web_" + randomBytes(12).toString("hex") });
      const { subscription, order } = await locked(sub.id, () => subs().createRenewalOrder(sub!.id));
      const payout = checkOrder(order, plan);
      if (!payout) {
        app.log.error({ orderId: order.id }, "relayer created a subscription order that does not match the plan; refused");
        await subs().cancel(sub.id);
        return reply.code(502).send(BAD_ORDER);
      }
      const body = { subscription: await view(subscription), checkout: checkout(order, payout, reply) };
      return reply.code(201).send(body);
    } catch (e) {
      opts.log.error(e);
      if (sub) await subs().cancel(sub.id).catch(() => undefined);
      return reply.code(502).send(BAD_ORDER);
    }
  });

  app.get<{ Params: { id: string } }>("/api/subscriptions/:id", async (req, reply) => {
    if (!publicGate(req.ip, reply, opts.readLimiter)) return reply;
    const s = idOk(req.params.id) ? await subs().get(req.params.id) : undefined;
    const v = s && (await view(s));
    return v ?? reply.code(404).send({ error: "Subscription not found." });
  });

  app.post<{ Params: { id: string } }>("/api/subscriptions/:id/renew", async (req, reply) => {
    if (!publicGate(req.ip, reply, opts.limiter)) return reply;
    const id = req.params.id;
    const s0 = idOk(id) ? await subs().get(id) : undefined;
    if (!s0) return reply.code(404).send({ error: "Subscription not found." });
    if (s0.status === "cancelled") return reply.code(409).send({ error: "This subscription is cancelled." });
    if (!s0.pendingOrderId && s0.nextChargeAt > nowSec()) return reply.code(409).send({ error: `Paid until ${iso(s0.nextChargeAt)}` });
    try {
      const { subscription, order } = await locked(id, () => subs().createRenewalOrder(id));
      const plan = await subs().listPlans().then((l) => l.find((p) => p.id === subscription.planId));
      const payout = plan && checkOrder(order, plan);
      if (!payout) {
        app.log.error({ orderId: order.id }, "relayer created a renewal order that does not match the plan; refused");
        return reply.code(502).send(BAD_ORDER);
      }
      return { subscription: await view(subscription), checkout: checkout(order, payout, reply) };
    } catch (e) {
      if (e instanceof realSdk.QuietpayConfigError && /paid until|not due/i.test(e.message)) {
        const now = await subs().get(id);
        return reply.code(409).send({ error: `Paid until ${iso(now?.nextChargeAt ?? nowSec())}` });
      }
      opts.log.error(e);
      return reply.code(502).send(BAD_ORDER);
    }
  });

  app.post<{ Params: { id: string } }>("/api/subscriptions/:id/cancel", async (req, reply) => {
    if (!publicGate(req.ip, reply, opts.readLimiter)) return reply;
    const s = idOk(req.params.id) ? await subs().get(req.params.id) : undefined;
    if (!s) return reply.code(404).send({ error: "Subscription not found." });
    const v = await view(await subs().cancel(s.id));
    return v;
  });

  return {
    enabled,
    /** Feed a verified, relayer-confirmed webhook into the subscriptions. No-op when subscriptions are off. */
    async applyWebhook(event: WebhookEvent): Promise<void> {
      if (!enabled) return;
      await subs().applyWebhook(event);
    },
  };
}
