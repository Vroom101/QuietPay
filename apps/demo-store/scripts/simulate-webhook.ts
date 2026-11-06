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
const secret = process.env.QUIETPAY_WEBHOOK_SECRET || "dev-webhook-secret";
const res = await fetch(`http://127.0.0.1:${process.env.PORT ?? 3001}/webhooks/quietpay`, {
  method: "POST",
  headers: { "content-type": "application/json", "quietpay-signature": signWebhook(secret, body) },
  body,
});
console.log(res.status, await res.text());
