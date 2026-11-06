import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Hex } from "viem";
import { ORDER_TOKEN_HEADER, type Order } from "@quietpay/shared";
import type { WebhookEvent } from "@quietpay/shared/webhook";
import {
  CustomerRefundStore, createCostLimiter, hashToken, ipKey, newOrderToken, rankOfOrderStatus, tokenMatches,
} from "./customer-refunds.js";

export interface CustomerRefundConfig {
  baseUrl: string;
  apiKey: string;
  merchantId: string;
  /** Own SQLite file for the customer refund tables; ":memory:" when omitted. */
  customerRefundDatabasePath?: string;
  /** Per-IP (v4 /32, v6 /64) and per-order request budgets per window. A failed attempt costs 2. */
  customerRefundRateLimit?: { perIp?: number; perOrder?: number; windowMs?: number };
  /** Clock in ms (tests). */
  now?: () => number;
}

const SYNC_AFTER_SEC = 60;
const ORDER_ID = /^0x[0-9a-fA-F]{64}$/;
const NOT_FOUND = { error: "not_found" } as const;

type Sdk = {
  getOrder?: unknown;
  listRefunds?: (o: { baseUrl: string; apiKey: string; orderId: Hex }) => Promise<import("@quietpay/shared").Refund[]>;
};

export function setPrivateHeaders(reply: FastifyReply) {
  reply.header("Cache-Control", "no-store");
  reply.header("Vary", ORDER_TOKEN_HEADER);
  reply.header("Referrer-Policy", "no-referrer");
}

export function registerCustomerRefunds(app: FastifyInstance, sdk: Sdk, config: CustomerRefundConfig) {
  const now = config.now ?? Date.now;
  const nowSec = () => Math.floor(now() / 1000);
  const store = new CustomerRefundStore(config.customerRefundDatabasePath ?? ":memory:");
  app.addHook("onClose", async () => store.close());
  const windowMs = config.customerRefundRateLimit?.windowMs ?? 60_000;
  const ipLimiter = createCostLimiter(config.customerRefundRateLimit?.perIp ?? 60, windowMs, now);
  const orderLimiter = createCostLimiter(config.customerRefundRateLimit?.perOrder ?? 30, windowMs, now);
  const inflight = new Map<string, Promise<void>>();

  /** True when the request is allowed to read this order. Sends the reply itself when it is not. */
  function authenticate(req: FastifyRequest, reply: FastifyReply, rawId: string): Hex | undefined {
    setPrivateHeaders(reply);
    const ip = ipKey(req.ip);
    if (ipLimiter.blocked(ip)) { reply.header("Retry-After", Math.ceil(windowMs / 1000)).code(429).send({ error: "rate_limited" }); return undefined; }
    const rawQuery = req.url.includes("?") ? req.url.slice(req.url.indexOf("?") + 1) : "";
    if (/(^|[&;])[^=&;]*token/i.test(decodeSafe(rawQuery))) {
      ipLimiter.add(ip, 2);
      reply.code(400).send({ error: "token_must_be_sent_in_header" });
      return undefined;
    }
    const id = rawId.toLowerCase();
    const idOk = ORDER_ID.test(id);
    // Always hash and compare, against a dummy digest when the order is unknown or the id is malformed.
    const stored = idOk ? store.tokenHashHex(id) : undefined;
    const ok = tokenMatches(req.headers[ORDER_TOKEN_HEADER.toLowerCase()], stored);
    if (ok) {
      ipLimiter.add(ip, 1);
      return id as Hex;
    }
    ipLimiter.add(ip, 2);
    const orderKey = id.slice(0, 80);
    orderLimiter.add(orderKey, 2);
    if (orderLimiter.blocked(orderKey)) reply.header("Retry-After", Math.ceil(windowMs / 1000)).code(429).send({ error: "rate_limited" });
    else reply.code(404).send(NOT_FOUND);
    return undefined;
  }

  /** Refresh from the relayer (merchant key, server side) when settled-or-later and the last sync is old. */
  async function reconcile(orderId: Hex) {
    const age = store.syncAgeSec(orderId, nowSec());
    if (age === undefined || age <= SYNC_AFTER_SEC || !sdk.listRefunds) return;
    const running = inflight.get(orderId);
    if (running) return running;
    const job = (async () => {
      try {
        const refunds = await sdk.listRefunds!({ baseUrl: config.baseUrl, apiKey: config.apiKey, orderId });
        if (!store.mergeRefunds(orderId, refunds, nowSec())) app.log.warn({ orderId }, "refund reconciliation rejected an inconsistent refund list");
      } catch (e) {
        app.log.warn({ orderId, err: (e as Error).message }, "refund reconciliation failed");
      } finally {
        inflight.delete(orderId);
      }
    })();
    inflight.set(orderId, job);
    return job;
  }

  app.get("/api/orders/:id/refund-status", async (req, reply) => {
    const orderId = authenticate(req, reply, (req.params as { id: string }).id);
    if (!orderId) return reply;
    await reconcile(orderId);
    return store.view(orderId) ?? reply.code(404).send(NOT_FOUND);
  });

  return {
    store,
    /** Called once per new order: returns the one-time token. */
    issueToken(order: Order): string {
      const token = newOrderToken();
      store.createOrder(order.id, hashToken(token), order.amount, nowSec());
      return token;
    },
    /** For the legacy /paid route: undefined = no credential on file (legacy order), true/false = checked. */
    checkPaidAccess(req: FastifyRequest, reply: FastifyReply, rawId: string): "legacy" | "allowed" | "denied" {
      const id = rawId.toLowerCase();
      if (!ORDER_ID.test(id) || !store.hasOrder(id)) return "legacy";
      const ok = tokenMatches(req.headers[ORDER_TOKEN_HEADER.toLowerCase()], store.tokenHashHex(id));
      setPrivateHeaders(reply);
      return ok ? "allowed" : "denied";
    },
    hasOrder: (id: string) => store.hasOrder(id),
    onSettled: (orderId: string, amount: string, status: string) =>
      store.applySettled(orderId, amount, rankOfOrderStatus(status), nowSec()),
    onRefundEvent: (event: WebhookEvent, raw: string) => store.applyRefundEvent(event, raw, nowSec()),
  };
}

function decodeSafe(s: string): string {
  try { return decodeURIComponent(s.replace(/\+/g, " ")); } catch { return s; }
}
