import Fastify, { type FastifyInstance } from "fastify";
import { parseUsdt } from "@quietpay/shared";
import type * as SdkApi from "@quietpay/merchant-sdk";

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
    const total = (req.body as { cartTotal?: unknown } | null)?.cartTotal;
    // NOTE: a real shop recomputes the total from its own cart/price data. The demo trusts the client.
    if (typeof total !== "string" || !/^\d{1,9}(\.\d{1,2})?$/.test(total)) {
      return reply.code(400).send({ error: "cartTotal must be a decimal string such as 25.00" });
    }
    let amount: bigint;
    try {
      amount = parseUsdt(total); // strict: throws on zero or malformed input
    } catch {
      return reply.code(400).send({ error: "cartTotal must be a positive decimal such as 25.00" });
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
