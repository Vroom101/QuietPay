import Fastify, { type FastifyInstance } from "fastify";
import { parseUsdt } from "@quietpay/shared";
import type * as SdkApi from "@quietpay/merchant-sdk";
import { PRODUCTS, cents, fromCents } from "../src/products.js";

/** The frozen merchant-SDK surface this server relies on. */
export type MerchantSdk = Pick<typeof SdkApi, "createOrder" | "getOrder" | "verifyWebhook">;

export interface StoreConfig {
  baseUrl: string;
  apiKey: string;
  merchantId: `0x${string}`;
  webhookSecret: string;
  /** Public URL the relayer should POST webhooks to (optional in dev). */
  webhookUrl?: string;
}

export interface PaidRecord {
  orderId: string;
  amount: string;
  payer?: string;
  txHash?: string;
  eventId: string;
  paidAt: number;
}

export function buildApp(sdk: MerchantSdk, config: StoreConfig) {
  const app: FastifyInstance = Fastify({ logger: false });
  const paid = new Map<string, PaidRecord>();
  const seenEvents = new Set<string>();

  app.post("/api/checkout", async (req, reply) => {
    const { items, cartTotal } = (req.body ?? {}) as { items?: unknown; cartTotal?: unknown };
    if (!items || typeof items !== "object" || Array.isArray(items)) {
      return reply.code(400).send({ error: "A cart with product quantities is required" });
    }

    let totalCents = 0;
    for (const [id, quantity] of Object.entries(items)) {
      const product = PRODUCTS.find((entry) => entry.id === id);
      if (!product || typeof quantity !== "number" || !Number.isSafeInteger(quantity) || quantity < 1) {
        return reply.code(400).send({ error: "The cart contains an invalid product or quantity" });
      }
      totalCents += cents(product.price) * quantity;
    }
    // Keep the previous checkout limit of nine whole digits and two decimal places.
    if (totalCents === 0 || totalCents > 99_999_999_999) {
      return reply.code(400).send({ error: "The cart total is outside the checkout limits" });
    }

    const total = fromCents(totalCents);
    if (cartTotal !== total) {
      return reply.code(409).send({ error: "The cart total has changed. Refresh the shop and try again." });
    }

    const amount = parseUsdt(total);
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
      if (seenEvents.has(event.id)) return { received: true, duplicate: true };
      seenEvents.add(event.id);
      if (event.type === "payment.settled") {
        paid.set(event.data.orderId.toLowerCase(), {
          orderId: event.data.orderId,
          amount: event.data.amount,
          payer: event.data.payer,
          txHash: event.data.txHash,
          eventId: event.id,
          paidAt: event.createdAt,
        });
      }
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
