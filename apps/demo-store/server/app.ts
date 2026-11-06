import {
  registerMerchantRefunds,
  type RefundSdk,
  type MerchantRefundConfig,
} from "./merchant-refunds.js";
import { ReceiptStore } from "./receipt-store.js";
import { PRODUCTS, cents, fromCents } from "../src/products.js";
import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { formatUsdt, parseUsdt } from "@quietpay/shared";
import { signWebhook } from "@quietpay/shared/webhook";
import type * as SdkApi from "@quietpay/merchant-sdk";
import { directPayment, type DemoQuote } from "../src/payment.js";
import { registerDemoBilling } from "./demo-billing.js";

/** The frozen merchant-SDK surface this server relies on. */
export type MerchantSdk = Pick<
  typeof SdkApi,
  "createOrder" | "getOrder" | "verifyWebhook"
> &
  Partial<RefundSdk>;

export interface StoreConfig {
  receiptDatabasePath?: string;
  refunds?: MerchantRefundConfig;
  baseUrl: string;
  apiKey: string;
  merchantId: `0x${string}`;
  webhookSecret: string;
  /** Public URL the relayer should POST webhooks to (optional in dev). */
  webhookUrl?: string;
  mockRelayer?: boolean;
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

function priceCart(body: unknown) {
    const { items, cartTotal } = (body ?? {}) as { items?: unknown; cartTotal?: unknown };
    if (!items || typeof items !== "object" || Array.isArray(items))
      return { status: 400, error: "A cart with product quantities is required" };
    let totalCents = 0n;
    for (const [id, quantity] of Object.entries(items)) {
      const product = PRODUCTS.find(p => p.id === id);
      if (!product || typeof quantity !== "number" || !Number.isSafeInteger(quantity) || quantity < 1)
        return { status: 400, error: "The cart contains an invalid product or quantity" };
      totalCents += parseUsdt(product.price) / 10000n * BigInt(quantity);
    }
    if (totalCents <= 0n || totalCents > 99_999_999_999n)
      return { status: 400, error: "The cart total is outside the checkout limits" };
    const total = `${totalCents / 100n}.${(totalCents % 100n).toString().padStart(2, "0")}`;
    if (cartTotal !== total)
      return { status: 409, error: `The cart total has changed to ${total} USDT. Review your cart before paying.` };
    return { total, totalCents: Number(totalCents) };
}

export function buildApp(sdk: MerchantSdk, config: StoreConfig) {
  if (config.mockRelayer && config.refunds) throw new Error("Live merchant refunds require a real relayer.");
  const app: FastifyInstance = Fastify({ logger: false });
  const receipts = new ReceiptStore(config.receiptDatabasePath ?? ":memory:",
    JSON.stringify([config.baseUrl.replace(/\/+$/, ""), config.merchantId.toLowerCase(), ...(config.mockRelayer ? ["mock"] : [])]));
  app.addHook("onClose", async () => receipts.close());
  const mockOrders = new Set<string>();
  const quotes = new Map<string, DemoQuote>();
  const simulations = new Map<string, { quote: DemoQuote; confirmedAt: number }>();
  const demoMethod = { id: "demo-stablecoin", name: "Demo stablecoin", symbol: "DEMO", simulated: true };
  const billing = config.mockRelayer && config.demoConversion ? registerDemoBilling(app, () => [
    ...[...mockOrders].flatMap((id) => {
      const receipt = receipts.get(id);
      return receipt ? [{ id, amount: formatUsdt(receipt.amount), placedAt: receipt.paidAt * 1000 }] : [];
    }),
    ...[...simulations].map(([id, { quote, confirmedAt }]) => ({ id, amount: quote.payAmount, placedAt: confirmedAt * 1000 })),
  ].sort((a, b) => b.placedAt - a.placedAt)) : undefined;

  app.get("/api/checkout/methods", async () => ({
    methods: billing ? [directPayment, demoMethod] : [directPayment],
    settlementSymbol: directPayment.symbol,
    mockRelayer: config.mockRelayer === true,
  }));

  if (billing) {
    app.post("/api/checkout/demo-quote", async (req, reply) => {
      const { methodId, destinationId = directPayment.id, invoiceId } = (req.body ?? {}) as { methodId?: unknown; destinationId?: unknown; invoiceId?: unknown };
      if (methodId !== demoMethod.id || destinationId !== directPayment.id) return reply.code(400).send({ error: "This demo payment route is unavailable." });
      const invoice = typeof invoiceId === "string" ? billing.getInvoice(invoiceId) : undefined;
      if (invoiceId !== undefined && !invoice) return reply.code(404).send({ error: "This invoice link is unavailable." });
      if (invoice?.paymentId) return reply.code(409).send({ error: "This invoice has already been paid." });
      const priced = invoice ? { total: invoice.amount, totalCents: cents(invoice.amount) } : priceCart(req.body);
      if (priced.error !== undefined) return reply.code(priced.status).send({ error: priced.error });
      const now = Date.now();
      for (const [id, quote] of quotes) if (quote.expiresAt <= now) quotes.delete(id);
      const fee = Math.min(10, priced.totalCents);
      const quote: DemoQuote = { id: `demo-${randomUUID()}`, symbol: demoMethod.symbol, settlementSymbol: directPayment.symbol,
        payAmount: priced.total, merchantAmount: fromCents(priced.totalCents - fee), relayFee: fromCents(fee), expiresAt: now + 60_000,
        ...(invoice ? { invoiceId: invoice.id } : {}) };
      quotes.set(quote.id, quote);
      return quote;
    });
    app.post("/api/checkout/demo-confirm", async (req, reply) => {
      const quoteId = (req.body as { quoteId?: unknown } | null)?.quoteId;
      if (typeof quoteId !== "string") return reply.code(400).send({ error: "A quote is required." });
      if (simulations.has(quoteId)) return { orderId: quoteId };
      const quote = quotes.get(quoteId);
      if (!quote || quote.expiresAt <= Date.now()) return reply.code(409).send({ error: "Quote expired. Request a new quote to continue." });
      const invoice = quote.invoiceId ? billing.getInvoice(quote.invoiceId) : undefined;
      if (invoice?.paymentId) return reply.code(409).send({ error: "This invoice has already been paid." });
      if (invoice) invoice.paymentId = quoteId;
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
      if (config.mockRelayer) mockOrders.add(order.id.toLowerCase());
      return { orderId: order.id };
    } catch (e) {
      app.log.error(e);
      return reply.code(502).send({ error: "could not start checkout" });
    }
  });

  // Webhooks need the exact raw body for signature verification, so parse JSON as a string here only.
  app.register(async (hooks) => {
    hooks.addContentTypeParser(
      "application/json",
      { parseAs: "string" },
      (_req, body, done) => done(null, body),
    );
    hooks.post("/webhooks/quietpay", async (req, reply) => {
      const header = req.headers["quietpay-signature"];
      if (typeof header !== "string")
        return reply.code(400).send({ error: "missing signature" });
      let event;
      try {
        event = sdk.verifyWebhook({
          secret: config.webhookSecret,
          body: req.body as string,
          signatureHeader: header,
        });
      } catch {
        return reply.code(400).send({ error: "invalid webhook" });
      }
      if (event.data.merchantId.toLowerCase() !== config.merchantId.toLowerCase())
        return reply.code(400).send({ error: "Webhook belongs to another merchant" });
      const fresh = receipts.record(event.id, event.type === "payment.settled" ? {
        orderId: event.data.orderId, amount: event.data.amount,
        payer: event.data.payer, txHash: event.data.txHash,
        eventId: event.id, paidAt: event.createdAt,
      } : undefined);
      if (!fresh) return { received: true, duplicate: true };
      return { received: true };
    });
  });

  app.get("/api/orders/:id/paid", async (req) => {
    const id = (req.params as { id: string }).id.toLowerCase();
    const simulation = simulations.get(id);
    if (simulation) return { paid: false, simulation, refunds: billing?.getRefunds(id) ?? [] };
    const isMock = mockOrders.has(id);
    if (isMock && !receipts.get(id)) {
      try {
        const order = await sdk.getOrder({ baseUrl: config.baseUrl, orderId: id as `0x${string}` });
        if (order.status === "settled" && order.id.toLowerCase() === id && order.txHash) {
          const body = JSON.stringify({ id: `demo-settled-${id}`, type: "payment.settled",
            createdAt: order.settledAt ?? Math.floor(Date.now() / 1000),
            data: { orderId: order.id, merchantId: order.merchantId, amount: order.amount,
              fee: order.fee, payer: order.payer, payout: order.payout, txHash: order.txHash } });
          await app.inject({ method: "POST", url: "/webhooks/quietpay", payload: body, headers: {
            "content-type": "application/json", "quietpay-signature": signWebhook(config.webhookSecret, body),
          } });
        }
      } catch (error) {
        app.log.warn(error, "Could not read mock settlement");
      }
    }
    const rec = receipts.get(id);
    if (!rec) return { paid: false };
    if (config.mockRelayer) return { paid: true, ...rec, demo: true, refunds: billing?.getRefunds(id) ?? [] };
    // A relayer read can add refund status to an already verified receipt, but cannot mark it paid.
    try {
      const order = await sdk.getOrder({ baseUrl: config.baseUrl, orderId: id as `0x${string}` });
      if (order.id.toLowerCase() === id && order.merchantId.toLowerCase() === config.merchantId.toLowerCase()) {
        return { paid: true, ...rec, refunded: order.refunded, refundCount: order.refundCount, orderStatus: order.status };
      }
    } catch (error) {
      app.log.warn(error, "Could not refresh receipt refund status");
    }
    return { paid: true, ...rec };
  });

  registerMerchantRefunds(app, sdk, config);
  return app;
}
