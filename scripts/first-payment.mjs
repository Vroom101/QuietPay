// CP1: one real USDT payment from a payer with zero WBT, through the live relayer.
// Usage (local shell, from the repo root):
//   RELAYER_URL=... QUIETPAY_API_KEY=... QUIETPAY_MERCHANT_ID=0x... PAYER_PRIVATE_KEY=0x... \
//   pnpm --filter @quietpay/shared exec tsx ../../scripts/first-payment.mjs
import { privateKeyToAccount } from "viem/accounts";
import { buildCheckoutAuthorization } from "@quietpay/shared";

const { RELAYER_URL, QUIETPAY_API_KEY, QUIETPAY_MERCHANT_ID, PAYER_PRIVATE_KEY } = process.env;
const amount = process.env.AMOUNT ?? "1000000"; // 1 USDT
if (!RELAYER_URL || !QUIETPAY_API_KEY || !QUIETPAY_MERCHANT_ID || !PAYER_PRIVATE_KEY) {
  throw new Error("Set RELAYER_URL, QUIETPAY_API_KEY, QUIETPAY_MERCHANT_ID, PAYER_PRIVATE_KEY");
}
const j = async (r) => {
  const b = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(b));
  return b;
};
const payer = privateKeyToAccount(PAYER_PRIVATE_KEY);
const order = await j(
  await fetch(`${RELAYER_URL}/v1/orders`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${QUIETPAY_API_KEY}` },
    body: JSON.stringify({ merchantId: QUIETPAY_MERCHANT_ID, amount, reference: "first-payment" }),
  }),
);
const now = Math.floor(Date.now() / 1000);
const c = order.checkout;
const validAfter = now - 5;
const validBefore = now + 300;
const signature = await payer.signTypedData(
  buildCheckoutAuthorization({
    from: payer.address,
    router: c.router,
    value: BigInt(c.value),
    nonce: c.nonce,
    validAfter: BigInt(validAfter),
    validBefore: BigInt(validBefore),
    chainId: c.chainId,
    token: c.token,
    domainName: c.domain.name,
    domainVersion: c.domain.version,
  }),
);
const relay = await j(
  await fetch(`${RELAYER_URL}/v1/relay/pay`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ orderId: order.id, payer: payer.address, validAfter, validBefore, signature, amount }),
  }),
);
console.log("submitted", relay.txHash);
for (let i = 0; i < 60; i++) {
  const o = await j(await fetch(`${RELAYER_URL}/v1/orders/${order.id}`));
  if (o.status === "settled") {
    console.log("SETTLED", o.explorerUrl ?? o.txHash);
    process.exit(0);
  }
  if (o.status === "failed" || o.status === "expired") throw new Error(`order ${o.status}`);
  await new Promise((r) => setTimeout(r, 1000));
}
throw new Error("timed out");
