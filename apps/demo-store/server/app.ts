import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import type * as SdkApi from "@quietpay/merchant-sdk";
import { CartError, priceCart } from "./catalog.js";

/** The frozen merchant-SDK surface this server relies on. */
export type MerchantSdk = Pick<typeof SdkApi, "createOrder" | "getOrder" | "verifyWebhook">;

export interface StoreConfig {
  baseUrl: string;
  apiKey: string;
  merchantId: `0x${string}`;
  webhookSecret: string;
  /** Public URL the relayer should POST webhooks to (optional in dev). */
  webhookUrl?: string;
  /**
   * Optional JSON file that persists paid orders and processed webhook event ids across restarts.
   * When omitted (tests), state is in memory only.
   */
  stateFile?: string;
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
  const app: FastifyInstance = Fastify({ logger: false });
  const state = loadState(config.stateFile);
  const paid = new Map<string, PaidRecord>(Object.entries(state.paid));
  const seenEvents = new Map<string, number>(Object.entries(state.seenEvents));
  const merchantId = config.merchantId.toLowerCase();

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

  app.post("/api/checkout", async (req, reply) => {
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
      return { orderId: order.id };
    } catch (e) {
      app.log.error(e);
      return reply.code(502).send({ error: "could not start checkout" });
    }
  });

  // Webhooks need the exact raw body for signature verification, so parse JSON as a string here only.
  app.register(async (hooks) => {
    hooks.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => done(null, body));
    hooks.post("/webhooks/quietpay", async (req, reply) => {
      const header = req.headers["quietpay-signature"];
      if (typeof header !== "string") return reply.code(400).send({ error: "missing signature" });
      let event;
      try {
        event = sdk.verifyWebhook({ secret: config.webhookSecret, body: req.body as string, signatureHeader: header });
      } catch {
        return reply.code(400).send({ error: "invalid webhook" });
      }

      // The relayer signs every merchant's webhooks with one shared secret, so a valid signature alone does not
      // prove the event is for THIS store. Reject events addressed to another merchant.
      if (event.data.merchantId.toLowerCase() !== merchantId) {
        return reply.code(400).send({ error: "event is for a different merchant" });
      }

      if (seenEvents.has(event.id)) return { received: true, duplicate: true };
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
          order.status === "settled" &&
          order.amount === event.data.amount;
        if (confirmed) {
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
      persist();
      return { received: true };
    });
  });

  app.get("/api/orders/:id/paid", async (req) => {
    const id = (req.params as { id: string }).id.toLowerCase();
    const rec = paid.get(id);
    return rec ? { paid: true, ...rec } : { paid: false };
  });

  return app;
}
