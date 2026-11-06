import { ReceiptStore } from "./receipt-store.js";
import { registerMerchantRefunds, type RefundSdk, type MerchantRefundConfig } from "./merchant-refunds.js";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import type * as SdkApi from "@quietpay/merchant-sdk";
import { formatUsdt, ORDER_TOKEN_HEADER } from "@quietpay/shared";
import { CartError, priceCart } from "./catalog.js";
import { registerCustomerRefunds, setPrivateHeaders, type CustomerRefundConfig } from "./customer-refund-routes.js";
import { REDACTED_HEADERS } from "./customer-refunds.js";

/** The frozen merchant-SDK surface this server relies on. */
export type MerchantSdk = Pick<typeof SdkApi, "createOrder" | "getOrder" | "verifyWebhook"> & Partial<RefundSdk>;

export interface StoreConfig extends Partial<Pick<CustomerRefundConfig, "customerRefundDatabasePath" | "customerRefundRateLimit" | "now">> {
  /** Enable the Fastify logger; the order token and Authorization headers are always redacted. */
  logger?: boolean | { stream?: NodeJS.WritableStream; level?: string };
  refunds?: MerchantRefundConfig;
  receiptDatabasePath?: string;
  baseUrl: string;
  apiKey: string;
  merchantId: `0x${string}`;
  /**
   * The store's own payout address (where the PaymentRouter sends its USDT), from QUIETPAY_PAYOUT_ADDRESS.
   * When set, an order the relayer creates with any other payout is refused, and this address is handed to the
   * widget as expected-payout. When unset, the payout from the relayer's authenticated createOrder answer is pinned.
   */
  payout?: `0x${string}`;
  webhookSecret: string;
  /** Public URL the relayer should POST webhooks to (optional in dev). */
  webhookUrl?: string;
  /**
   * Optional JSON file that persists paid orders and processed webhook event ids across restarts.
   * When omitted (tests), state is in memory only.
   */
  stateFile?: string;
  /** Max POST /api/checkout calls per IP per window (default 20). */
  checkoutRateLimit?: number;
  /** Length of the checkout rate-limit window in ms (default 60 000). */
  checkoutRateWindowMs?: number;
}

export interface PaidRecord {
  orderId: string;
  amount: string;
  payer?: string;
  txHash?: string;
  eventId: string;
  paidAt: number;
}

interface PersistedState {
  /** event id -> ms timestamp when first processed. */
  seenEvents: Record<string, number>;
  /** lower-cased order id -> record. */
  paid: Record<string, PaidRecord>;
}

/** Processed event ids are kept this long. Signatures older than 300 s are rejected anyway (see verifyWebhook). */
const SEEN_EVENT_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Default checkout limit: requests per IP per window. Overridable through StoreConfig for tests. */
const DEFAULT_CHECKOUT_LIMIT = 20;
const DEFAULT_CHECKOUT_WINDOW_MS = 60_000;
/** Hard cap on tracked IPs so a flood of spoofed or distinct addresses cannot grow memory without bound. */
const MAX_TRACKED_IPS = 10_000;

/**
 * Small fixed-window per-IP limiter kept in memory (resets on restart). Expired windows are swept at most once
 * per window, and if the table is still full after a sweep the oldest entries are dropped.
 */
function createIpLimiter(limit: number, windowMs: number, now: () => number = Date.now) {
  const windows = new Map<string, { count: number; resetAt: number }>();
  let lastSweep = now();

  function sweep(t: number) {
    for (const [ip, w] of windows) if (w.resetAt <= t) windows.delete(ip);
    lastSweep = t;
  }

  return {
    /** Returns true if the request is allowed (and counts it), false if the IP is over its limit. */
    allow(ip: string): boolean {
      const t = now();
      if (t - lastSweep >= windowMs) sweep(t);
      let w = windows.get(ip);
      if (!w || w.resetAt <= t) {
        if (!w && windows.size >= MAX_TRACKED_IPS) {
          // Map iterates in insertion order, so this drops the oldest tracked IP.
          const oldest = windows.keys().next().value;
          if (oldest !== undefined) windows.delete(oldest);
        }
        w = { count: 0, resetAt: t + windowMs };
        windows.set(ip, w);
      }
      if (w.count >= limit) return false;
      w.count += 1;
      return true;
    },
  };
}

function loadState(file: string | undefined): PersistedState {
  const empty: PersistedState = { seenEvents: Object.create(null), paid: Object.create(null) };
  if (!file) return empty;
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return empty;
    throw e;
  }
  const parsed = JSON.parse(raw) as Partial<PersistedState>;
  // Copy into null-prototype objects so persisted keys such as "__proto__" stay plain data.
  return {
    seenEvents: Object.assign(Object.create(null), parsed.seenEvents ?? {}),
    paid: Object.assign(Object.create(null), parsed.paid ?? {}),
  };
}

export function buildApp(sdk: MerchantSdk, config: StoreConfig) {
  // Body size and timeout limits (W3) plus a header-redacting logger (W5).
  const app: FastifyInstance = Fastify({
    logger: config.logger
      ? { level: "info", redact: { paths: REDACTED_HEADERS, censor: "[redacted]" }, ...(typeof config.logger === "object" ? config.logger : {}) }
      : false,
    bodyLimit: 64 * 1024,
    requestTimeout: 30_000,
    connectionTimeout: 60_000,
  });
  app.server.headersTimeout = 15_000;
  const receipts = config.receiptDatabasePath ? new ReceiptStore(config.receiptDatabasePath,
    JSON.stringify([config.baseUrl.replace(/\/+$/, ""), config.merchantId.toLowerCase()])) : undefined;
  app.addHook("onClose", async () => receipts?.close());
  app.get("/health", async () => ({ ok: true })); // platform health check; reveals nothing
  app.get("/api/checkout/methods", async () => ({ methods: [{ id: "usdt", name: "Tether USD", symbol: "USDT", simulated: false }] }));
  const state = loadState(config.stateFile);
  const paid = new Map<string, PaidRecord>(Object.entries(state.paid));
  const seenEvents = new Map<string, number>(Object.entries(state.seenEvents));
  const merchantId = config.merchantId.toLowerCase();
  const checkoutLimiter = createIpLimiter(
    config.checkoutRateLimit ?? DEFAULT_CHECKOUT_LIMIT,
    config.checkoutRateWindowMs ?? DEFAULT_CHECKOUT_WINDOW_MS,
  );

  /**
   * Persist after every change (atomic write via rename). Without a stateFile the records live in memory only:
   * a restart then forgets processed event ids, but a replay of an old delivery is still bounded by the 300 s
   * signature timestamp tolerance, and every settled event is re-confirmed against the relayer anyway.
   */
  function persist() {
    if (!config.stateFile) return;
    const cutoff = Date.now() - SEEN_EVENT_RETENTION_MS;
    for (const [id, at] of seenEvents) if (at < cutoff) seenEvents.delete(id);
    const out: PersistedState = { seenEvents: Object.fromEntries(seenEvents), paid: Object.fromEntries(paid) };
    mkdirSync(dirname(config.stateFile), { recursive: true });
    const tmp = `${config.stateFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(out));
    renameSync(tmp, config.stateFile);
  }

  const customer = registerCustomerRefunds(app, sdk, config);

  app.post("/api/checkout", async (req, reply) => {
    // Every accepted call creates a relayer order under the store's API key, so the public endpoint is per-IP limited.
    if (!checkoutLimiter.allow(req.ip)) return reply.code(429).send({ error: "too many checkout requests, try again shortly" });
    // SECURITY: the browser sends only product ids and quantities. The total is computed here from the
    // server-side catalog (server/catalog.ts); any client-supplied price or total (e.g. `cartTotal`) is ignored.
    const items = (req.body as { items?: unknown } | null)?.items;
    let amount: bigint;
    try {
      amount = priceCart(items).total;
    } catch (e) {
      if (e instanceof CartError) return reply.code(400).send({ error: e.message });
      throw e;
    }
    try {
      const order = await sdk.createOrder({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        merchantId: config.merchantId,
        amount: amount.toString(),
        reference: `demo-${Date.now()}`,
        webhookUrl: config.webhookUrl,
      });
      // Only hand the browser an order that is exactly what this store asked for: our merchant, the amount we just
      // priced, and (when configured) our payout address.
      const payout = config.payout ?? order.payout;
      if (
        order.merchantId.toLowerCase() !== merchantId ||
        order.amount !== amount.toString() ||
        order.payout.toLowerCase() !== payout.toLowerCase()
      ) {
        app.log.error({ orderId: order.id }, "relayer created an order that does not match the cart; refused");
        return reply.code(502).send({ error: "could not start checkout" });
      }
      // The widget pins these too (expected-amount / expected-payout) and refuses to sign anything else.
      // The order status token is shown once; only its sha256 is kept. Never cache this response.
      setPrivateHeaders(reply);
      // It travels in a response header so the existing JSON body shape stays exactly as it was.
      reply.header(ORDER_TOKEN_HEADER, customer.issueToken(order));
      return { orderId: order.id, amount: formatUsdt(amount), payout };
    } catch (e) {
      app.log.error(e);
      return reply.code(502).send({ error: "could not start checkout" });
    }
  });

  // Webhooks need the exact raw body for signature verification, so parse JSON as a string here only.
  app.register(async (hooks) => {
    hooks.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => done(null, body));
    hooks.post("/webhooks/quietpay", { bodyLimit: 64 * 1024 }, async (req, reply) => {
      const header = req.headers["quietpay-signature"];
      if (typeof header !== "string") return reply.code(400).send({ error: "missing signature" });
      let event;
      try {
        event = sdk.verifyWebhook({ secret: config.webhookSecret, body: req.body as string, signatureHeader: header });
      } catch {
        return reply.code(400).send({ error: "invalid webhook" });
      }

      // Each merchant has its own derived webhook secret, HMAC-SHA256(master WEBHOOK_SECRET, merchantId), so a valid
      // signature shows the event came from a holder of this store's secret. It does not prove the event is for THIS
      // store, so reject events addressed to another merchant.
      if (event.data.merchantId.toLowerCase() !== merchantId) {
        return reply.code(400).send({ error: "event is for a different merchant" });
      }

      // A refund for an order this store never created is refused and nothing is stored.
      if (event.type === "payment.refunded" && !customer.hasOrder(event.data.orderId)) {
        return reply.code(400).send({ error: "unknown order" });
      }

      if (receipts?.hasEvent(event.id) || seenEvents.has(event.id)) return { received: true, duplicate: true };
      // Claim the id before any await so a concurrent duplicate delivery is treated as a duplicate.
      seenEvents.set(event.id, Date.now());

      if (event.type === "payment.settled") {
        const orderId = event.data.orderId;
        let order;
        try {
          // Do not trust the event body: re-read the order from the relayer and require that it is ours,
          // settled, and for the same amount before marking it paid.
          order = await sdk.getOrder({ baseUrl: config.baseUrl, orderId: orderId as `0x${string}` });
        } catch (e) {
          app.log.error(e);
          seenEvents.delete(event.id); // let the relayer's retry be processed
          return reply.code(502).send({ error: "could not confirm order with the relayer" });
        }
        const confirmed =
          order.id.toLowerCase() === orderId.toLowerCase() &&
          order.merchantId.toLowerCase() === merchantId &&
          ["settled", "partially_refunded", "refunded"].includes(order.status) &&
          order.amount === event.data.amount;
        if (confirmed) {
          try {
            customer.onSettled(orderId, order.amount, order.status);
          } catch (e) {
            app.log.error(e);
            seenEvents.delete(event.id);
            return reply.code(500).send({ error: "could not record settlement" });
          }
          paid.set(orderId.toLowerCase(), {
            orderId: order.id,
            amount: order.amount,
            payer: order.payer,
            txHash: order.txHash,
            eventId: event.id,
            paidAt: event.createdAt,
          });
        } else {
          app.log.warn({ eventId: event.id, orderId }, "payment.settled webhook did not match the relayer's order; ignored");
        }
      }
      if (event.type === "payment.refunded") {
        const orderId = event.data.orderId;
        let order;
        try {
          // Same rule as settlement: never trust the body, re-read the order from the relayer first.
          order = await sdk.getOrder({ baseUrl: config.baseUrl, orderId: orderId as `0x${string}` });
        } catch (e) {
          app.log.error(e);
          seenEvents.delete(event.id);
          return reply.code(502).send({ error: "could not confirm order with the relayer" });
        }
        const reported = order.refundedAmount ?? order.refunded;
        const confirmed =
          order.id.toLowerCase() === orderId.toLowerCase() &&
          order.merchantId.toLowerCase() === merchantId &&
          ["settled", "partially_refunded", "refunded"].includes(order.status) &&
          order.amount === event.data.amount &&
          (reported === undefined || BigInt(reported) >= BigInt(event.data.totalRefunded ?? "0"));
        if (confirmed) {
          let outcome;
          try {
            outcome = customer.onRefundEvent(event, req.body as string);
          } catch (e) {
            app.log.error(e);
            seenEvents.delete(event.id);
            return reply.code(500).send({ error: "could not record refund" });
          }
          if (outcome === "rejected") {
            app.log.warn({ eventId: event.id, orderId }, "payment.refunded webhook was inconsistent with the stored order; rejected");
            seenEvents.delete(event.id);
            return reply.code(400).send({ error: "invalid refund event" });
          }
        } else {
          app.log.warn({ eventId: event.id, orderId }, "payment.refunded webhook did not match the relayer's order; ignored");
        }
      }
      receipts?.record(event.id, paid.get(event.data.orderId.toLowerCase()));
      persist();
      return { received: true };
    });
  });

  app.get("/api/orders/:id/paid", async (req, reply) => {
    const id = (req.params as { id: string }).id.toLowerCase();
    // Orders created with a status token need it; without a valid one the answer is exactly the unknown-order answer.
    // Legacy orders (no token on file) keep the old behaviour.
    if (customer.checkPaidAccess(req, reply, id) === "denied") return { paid: false };
    const rec = receipts?.get(id) ?? paid.get(id);
    return rec ? { paid: true, ...rec } : { paid: false };
  });

  registerMerchantRefunds(app, sdk, config);
  return app;
}
