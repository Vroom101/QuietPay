/**
 * Payment links for the store server: a merchant without a website creates a link in the dashboard and sends it to a
 * customer. The link opens the hosted pay page (/pay/:id); each visit that starts a payment gets a fresh checkout
 * order for the link's exact amount, and a link counts as paid only when a verified payment.settled webhook (re-read
 * from the relayer by app.ts) names one of the orders issued for it. Built on the merchant SDK's client.links.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import * as realSdk from "@quietpay/merchant-sdk";
import type { Order } from "@quietpay/shared";
import { formatUsdt, parseUsdt, ORDER_TOKEN_HEADER } from "@quietpay/shared";
import type { WebhookEvent } from "@quietpay/shared/webhook";
import { setPrivateHeaders } from "./customer-refund-routes.js";
import { merchantAuthorized } from "./ledger-proxy.js";
import type { BillingMode } from "./subscriptions.js";

type PaymentLink = realSdk.PaymentLink;
type PaymentLinkStore = realSdk.PaymentLinkStore;

/** The part of the SDK client this module uses (typed locally so it compiles whatever the SDK build exposes). */
interface LinksApi {
  create(input: { title: string; amount: string; description?: string; singleUse?: boolean; expiresInSeconds?: number; id?: string }): Promise<PaymentLink>;
  get(id: string): Promise<PaymentLink | undefined>;
  list(): Promise<PaymentLink[]>;
  deactivate(id: string): Promise<PaymentLink>;
  checkout(id: string): Promise<{ link: PaymentLink; order: Order }>;
  applyWebhook(event: WebhookEvent): Promise<PaymentLink | undefined>;
}
type Client = ReturnType<typeof realSdk.createQuietPay> & { links: LinksApi };

export type LinkStatus = "active" | "paid" | "deactivated" | "expired";

export interface LinkView {
  id: string;
  title: string;
  description: string | null;
  amount: string;
  amountBase: string;
  singleUse: boolean;
  status: LinkStatus;
  paidCount: number;
  expiresAt: string | null;
  createdAt: string;
  lastPaidOrderId: string | null;
  duplicatePayments: number;
}
export interface PublicLinkView {
  id: string;
  title: string;
  description: string | null;
  amount: string;
  status: LinkStatus;
  expiresAt: string | null;
  merchantName: string;
}

export interface PaymentLinksOptions {
  baseUrl: string;
  apiKey: string;
  merchantId: `0x${string}`;
  payout?: `0x${string}`;
  webhookUrl?: string;
  billing?: BillingMode;
  paymentLinksFile?: string;
  merchantName?: string;
  dashboardToken?: string;
  acceptSession?: (token: string) => boolean;
  sdk: { createQuietPay?: typeof realSdk.createQuietPay };
  /** Test hook: fake relayer fetch for the links client. */
  fetch?: typeof fetch;
  /** Order-creating route (checkout). */
  limiter: { allow(ip: string): boolean };
  /** Read routes. */
  readLimiter: { allow(ip: string): boolean };
  customer: { issueToken(order: Order): string; hasOrder(id: string): boolean };
  log: { error(...args: unknown[]): void };
}

/** In-memory store, persisted to a JSON file (temp file + rename) after every write when a path is given. */
export function jsonFilePaymentLinkStore(file?: string): PaymentLinkStore {
  const links = new Map<string, PaymentLink>();
  if (file) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { links?: PaymentLink[] };
      for (const l of parsed.links ?? []) links.set(l.id, l);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  const save = () => {
    if (!file) return;
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ links: [...links.values()] }));
    renameSync(tmp, file);
  };
  const clone = (l: PaymentLink): PaymentLink => structuredClone(l);
  return {
    getLink: (id) => (links.has(id) ? clone(links.get(id)!) : undefined),
    putLink: (l) => { links.set(l.id, clone(l)); save(); },
    listLinks: () => [...links.values()].map(clone),
    // Synchronous, so the compare and the write cannot interleave with another request.
    compareAndSetLink: (prev, next) => {
      const cur = links.get(prev.id);
      if (!cur || JSON.stringify(cur) !== JSON.stringify(prev)) return false;
      links.set(next.id, clone(next));
      save();
      return true;
    },
  };
}

const SAFE_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const OFF = { error: "Payment links are turned off for this store." };
const MAX_AMOUNT = 1_000_000n * 1_000_000n;
const iso = (sec: number) => new Date(sec * 1000).toISOString();
const GONE: Record<Exclude<LinkStatus, "active">, string> = {
  paid: "This link has already been paid.",
  deactivated: "This link is no longer active.",
  expired: "This link has expired.",
};

export function registerPaymentLinks(app: FastifyInstance, opts: PaymentLinksOptions) {
  const enabled = (opts.billing ?? "both") !== "subscription";
  const merchantId = opts.merchantId.toLowerCase();
  const merchantName = opts.merchantName?.trim() || "Quiet Store";
  const nowSec = () => Math.floor(Date.now() / 1000);

  let client: Client | undefined;
  if (enabled) {
    const make = opts.sdk.createQuietPay ?? realSdk.createQuietPay;
    client = make({
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      merchantId: opts.merchantId,
      billing: "one_time",
      ...(opts.webhookUrl ? { webhookUrl: opts.webhookUrl } : {}),
      paymentLinkStore: jsonFilePaymentLinkStore(opts.paymentLinksFile),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    }) as Client;
  }
  const links = () => client!.links;

  const statusOf = (l: PaymentLink): LinkStatus =>
    l.status === "active" && l.expiresAt !== undefined && l.expiresAt <= nowSec() ? "expired" : l.status;
  const view = (l: PaymentLink): LinkView => ({
    id: l.id,
    title: l.title,
    description: l.description ?? null,
    amount: formatUsdt(l.amount),
    amountBase: l.amount,
    singleUse: l.singleUse,
    status: statusOf(l),
    paidCount: l.paidCount,
    expiresAt: l.expiresAt !== undefined ? iso(l.expiresAt) : null,
    createdAt: iso(l.createdAt),
    lastPaidOrderId: l.lastPaidOrderId ?? null,
    duplicatePayments: l.duplicatePayments?.length ?? 0,
  });
  const publicView = (l: PaymentLink): PublicLinkView => ({
    id: l.id,
    title: l.title,
    description: l.description ?? null,
    amount: formatUsdt(l.amount),
    status: statusOf(l),
    expiresAt: l.expiresAt !== undefined ? iso(l.expiresAt) : null,
    merchantName,
  });

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
  const idOk = (id: string) => SAFE_ID.test(id);
  const find = async (id: string) => (idOk(id) ? links().get(id) : undefined);

  // ---- merchant routes ----
  app.get("/api/merchant/links", async (req, reply) => {
    if (!merchantGate(req, reply)) return reply;
    const all = (await links().list()).map((l, i) => ({ l, i }));
    all.sort((a, b) => b.l.createdAt - a.l.createdAt || b.i - a.i);
    return { links: all.map((x) => view(x.l)) };
  });

  app.post("/api/merchant/links", async (req, reply) => {
    if (!merchantGate(req, reply)) return reply;
    const b = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
    const bad = (error: string) => reply.code(400).send({ error });
    if (typeof b.title !== "string" || !b.title.trim() || b.title.length > 80) return bad("title must be 1-80 characters");
    let description: string | undefined;
    if (b.description !== undefined && b.description !== null && b.description !== "") {
      if (typeof b.description !== "string" || b.description.length > 280) return bad("description must be at most 280 characters");
      description = b.description;
    }
    let base: bigint;
    try {
      if (typeof b.amount !== "string") throw new Error();
      base = parseUsdt(b.amount);
    } catch {
      return bad('amount must be a positive USDT amount with at most 6 decimals, e.g. "12.50"');
    }
    if (base > MAX_AMOUNT) return bad("amount must be at most 1,000,000 USDT");
    if (b.singleUse !== undefined && typeof b.singleUse !== "boolean") return bad("singleUse must be true or false");
    let expiresInSeconds: number | undefined;
    if (b.expiresInDays !== undefined && b.expiresInDays !== null) {
      const d = b.expiresInDays;
      if (typeof d !== "number" || !Number.isInteger(d) || d < 1 || d > 90) return bad("expiresInDays must be a whole number from 1 to 90");
      expiresInSeconds = d * 86400;
    }
    try {
      const link = await links().create({
        title: b.title.trim(),
        amount: base.toString(),
        ...(description !== undefined ? { description } : {}),
        singleUse: b.singleUse ?? true,
        ...(expiresInSeconds !== undefined ? { expiresInSeconds } : {}),
      });
      return reply.code(201).send(view(link));
    } catch (e) {
      if (e instanceof realSdk.QuietpayConfigError) return bad(e.message);
      throw e;
    }
  });

  app.post<{ Params: { id: string } }>("/api/merchant/links/:id/deactivate", async (req, reply) => {
    if (!merchantGate(req, reply)) return reply;
    const link = await find(req.params.id);
    if (!link) return reply.code(404).send({ error: "Link not found." });
    return view(await links().deactivate(link.id));
  });

  // ---- customer routes ----
  app.get<{ Params: { id: string } }>("/api/links/:id", async (req, reply) => {
    if (!publicGate(req.ip, reply, opts.readLimiter)) return reply;
    const link = await find(req.params.id);
    return link ? publicView(link) : reply.code(404).send({ error: "Link not found." });
  });

  app.post<{ Params: { id: string } }>("/api/links/:id/checkout", async (req, reply) => {
    if (!publicGate(req.ip, reply, opts.limiter)) return reply;
    const link = await find(req.params.id);
    if (!link) return reply.code(404).send({ error: "Link not found." });
    const status = statusOf(link);
    if (status !== "active") return reply.code(409).send({ error: GONE[status] });
    try {
      const { link: current, order } = await links().checkout(link.id);
      const payout = opts.payout ?? order.payout;
      if (
        order.merchantId.toLowerCase() !== merchantId ||
        order.amount !== current.amount ||
        order.payout.toLowerCase() !== payout.toLowerCase()
      ) {
        app.log.error({ orderId: order.id }, "relayer created a link order that does not match the link; refused");
        return reply.code(502).send({ error: "could not start checkout" });
      }
      setPrivateHeaders(reply);
      if (!opts.customer.hasOrder(order.id)) reply.header(ORDER_TOKEN_HEADER, opts.customer.issueToken(order));
      return reply.code(201).send({ checkout: { orderId: order.id, amount: formatUsdt(order.amount), payout } });
    } catch (e) {
      if (e instanceof realSdk.QuietpayConfigError) {
        // Paid, deactivated or expired between the read above and the checkout (or a link the SDK refuses).
        const now = await find(link.id);
        const st = now ? statusOf(now) : "deactivated";
        return reply.code(409).send({ error: st === "active" ? e.message : GONE[st] });
      }
      opts.log.error(e);
      return reply.code(502).send({ error: "could not start checkout" });
    }
  });

  return {
    enabled,
    /** Feed a verified, relayer-confirmed webhook into the links. No-op when links are off. */
    async applyWebhook(event: WebhookEvent): Promise<void> {
      if (!enabled) return;
      await links().applyWebhook(event);
    },
  };
}
