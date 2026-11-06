// Dev helper: the mock relayer does not send webhooks, so sign and POST one to the demo-store server.
// Usage: pnpm --filter @quietpay/demo-store simulate-webhook <orderId> [amountBaseUnits]
import { merchantIdFromSlug } from "@quietpay/shared";
import { signWebhook } from "@quietpay/shared/webhook";

const orderId = process.argv[2];
if (!orderId) throw new Error("usage: simulate-webhook <orderId> [amountBaseUnits]");
const body = JSON.stringify({
  id: `evt_sim_${Date.now()}`,
  type: "payment.settled",
  createdAt: Math.floor(Date.now() / 1000),
  data: {
    orderId,
    merchantId: process.env.QUIETPAY_MERCHANT_ID || merchantIdFromSlug("demo-store"),
    amount: process.argv[3] ?? "25000000",
    fee: "50000",
    payer: "0x3333333333333333333333333333333333333333",
    payout: "0x2222222222222222222222222222222222222222",
    txHash: "0x" + "cd".repeat(32),
  },
});
// Note: the server re-reads the order from the relayer and only marks it paid if the relayer reports it settled
// with the same amount, so this simulates delivery, not settlement.
const secret = process.env.QUIETPAY_WEBHOOK_SECRET;
if (!secret) throw new Error("QUIETPAY_WEBHOOK_SECRET is not set (use the same value as the demo-store server)");
const res = await fetch(`http://127.0.0.1:${process.env.PORT ?? 3001}/webhooks/quietpay`, {
  method: "POST",
  headers: { "content-type": "application/json", "quietpay-signature": signWebhook(secret, body) },
  body,
});
console.log(res.status, await res.text());
