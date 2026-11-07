import Fastify from "fastify";
import { createQuietPay } from "@quietpay/merchant-sdk";

// The whole merchant integration in 20 lines. createQuietPay() reads QUIETPAY_BASE_URL, _API_KEY, _MERCHANT_ID, _WEBHOOK_SECRET.
export function quickstart(qp = createQuietPay({ billing: "product" })) {
  const app = Fastify();
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => done(null, body)); // raw body for webhooks

  app.post("/checkout", async () => { // 1. create the order on your server, give these 3 values to the widget
    const order = await qp.createOrder({ amount: "8500000" }); // 8.50 USDT
    return { orderId: order.id, amount: "8.5", payout: order.payout };
  });
  app.post("/webhooks/quietpay", async (req, reply) => { // 2. the relayer tells you when it is paid
    let event;
    try { event = qp.verifyWebhook({ body: req.body as string, signatureHeader: String(req.headers["quietpay-signature"]) }); } catch { return reply.code(400).send({ error: "bad signature" }); }
    if (event.type === "payment.settled") console.log("paid:", event.data.orderId); // fulfil once per event.id
    return { received: true };
  });
  return app;
}
