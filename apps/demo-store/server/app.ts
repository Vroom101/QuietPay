import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { parseUsdt } from "@quietpay/shared";
import { signWebhook } from "@quietpay/shared/webhook";
import type * as SdkApi from "@quietpay/merchant-sdk";
import { PRODUCTS, cents, fromCents } from "../src/products.js";
import { directPayment, type DemoQuote, type PaymentMethod } from "../src/payment.js";

/** The frozen merchant-SDK surface this server relies on. */
export type MerchantSdk = Pick<typeof SdkApi, "createOrder" | "getOrder" | "verifyWebhook">;

export interface StoreConfig {
  baseUrl: string;
  apiKey: string;
  merchantId: `0x${string}`;
  webhookSecret: string;
  /** Public URL the relayer should POST webhooks to (optional in dev). */
  webhookUrl?: string;
  demoConversion?: boolean;
}

export interface PaidRecord {
  orderId: string;
  amount: string;
  payer?: string;
  txHash?: string;
  eventId: string;
  paidAt: number;
}

const demoMethods: PaymentMethod[] = [
  { id: "demo-stablecoin", name: "Demo stablecoin", symbol: "DEMO", simulated: true },
];

function priceCart(body: unknown) {
    const { items, cartTotal } = (body ?? {}) as { items?: unknown; cartTotal?: unknown };
    if (!items || typeof items !== "object" || Array.isArray(items)) {
      return { status: 400, error: "A cart with product quantities is required" };
    }

    let totalCents = 0;
    for (const [id, quantity] of Object.entries(items)) {
      const product = PRODUCTS.find((entry) => entry.id === id);
      if (!product || typeof quantity !== "number" || !Number.isSafeInteger(quantity) || quantity < 1) {
        return { status: 400, error: "The cart contains an invalid product or quantity" };
      }
      totalCents += cents(product.price) * quantity;
    }
    // Keep the previous checkout limit of nine whole digits and two decimal places.
    if (totalCents === 0 || totalCents > 99_999_999_999) {
      return { status: 400, error: "The cart total is outside the checkout limits" };
    }

    const total = fromCents(totalCents);
    if (cartTotal !== total) {
      return { status: 409, error: "The cart total has changed. Refresh the shop and try again." };
    }
    return { totalCents, total };
}

export function buildApp(sdk: MerchantSdk, config: StoreConfig) {
  const app: FastifyInstance = Fastify({ logger: false });
  const paid = new Map<string, PaidRecord>();
  const seenEvents = new Set<string>();
  const demoOrders = new Set<string>();
  const quotes = new Map<string, DemoQuote>();
  const simulations = new Map<string, { quote: DemoQuote; confirmedAt: number }>();
  const methods = config.demoConversion ? [directPayment, ...demoMethods] : [directPayment];

  app.get("/api/checkout/methods", async () => ({
    methods,
  }));

  if (config.demoConversion) {
    app.post("/api/checkout/demo-quote", async (req, reply) => {
      const { methodId, destinationId = directPayment.id } = (req.body ?? {}) as { methodId?: unknown; destinationId?: unknown };
      const method = methods.find((entry) => entry.id === methodId);
      const destination = methods.find((entry) => entry.id === destinationId);
      if (!method || !destination || (!method.simulated && !destination.simulated)) {
        return reply.code(400).send({ error: "This demo payment route is unavailable." });
      }
      const priced = priceCart(req.body);
      if (priced.error !== undefined) return reply.code(priced.status).send({ error: priced.error });

      const now = Date.now();
      for (const [id, quote] of quotes) if (quote.expiresAt <= now) quotes.delete(id);
      const fee = Math.min(10, priced.totalCents);
      const quote: DemoQuote = {
        id: `demo-${randomUUID()}`,
        symbol: method.symbol,
        settlementSymbol: destination.symbol,
        payAmount: priced.total,
        merchantAmount: fromCents(priced.totalCents - fee),
        relayFee: fromCents(fee),
        expiresAt: now + 60_000,
      };
      quotes.set(quote.id, quote);
      return quote;
    });

    app.post("/api/checkout/demo-confirm", async (req, reply) => {
      const quoteId = (req.body as { quoteId?: unknown } | null)?.quoteId;
      if (typeof quoteId !== "string") return reply.code(400).send({ error: "A quote is required." });
      if (simulations.has(quoteId)) return { orderId: quoteId };
      const quote = quotes.get(quoteId);
      if (!quote || quote.expiresAt <= Date.now()) return reply.code(409).send({ error: "Quote expired. Request a new quote to continue." });
      simulations.set(quoteId, { quote, confirmedAt: Math.floor(Date.now() / 1000) });
      quotes.delete(quoteId);
      return { orderId: quoteId };
    });
  }

  app.post("/api/checkout", async (req, reply) => {
    const priced = priceCart(req.body);
    if (priced.error !== undefined) return reply.code(priced.status).send({ error: priced.error });
    const amount = parseUsdt(priced.total);
    try {
      const order = await sdk.createOrder({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        merchantId: config.merchantId,
        amount: amount.toString(),
        reference: `demo-${Date.now()}`,
        webhookUrl: config.webhookUrl,
      });
      if (config.demoConversion) demoOrders.add(order.id.toLowerCase());
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
    const simulation = simulations.get(id);
    if (simulation) return { paid: false, simulation };
    const isDemo = demoOrders.has(id);
    // The local mock relayer settles orders but does not dispatch webhooks.
    if (isDemo && !paid.has(id)) {
      try {
        const order = await sdk.getOrder({ baseUrl: config.baseUrl, orderId: id as `0x${string}` });
        if (order.status === "settled" && order.id.toLowerCase() === id && order.txHash) {
          const body = JSON.stringify({
            id: `demo-settled-${id}`,
            type: "payment.settled",
            createdAt: order.settledAt ?? Math.floor(Date.now() / 1000),
            data: { orderId: order.id, merchantId: order.merchantId, amount: order.amount,
              fee: order.fee, payer: order.payer, payout: order.payout, txHash: order.txHash },
          });
          await app.inject({ method: "POST", url: "/webhooks/quietpay", payload: body, headers: {
            "content-type": "application/json", "quietpay-signature": signWebhook(config.webhookSecret, body),
          } });
        }
      } catch (error) {
        app.log.warn(error, "Could not read mock settlement");
      }
    }
    const rec = paid.get(id);
    return rec ? { paid: true, ...rec, ...(isDemo ? { demo: true } : {}) } : { paid: false };
  });

  return app;
}
