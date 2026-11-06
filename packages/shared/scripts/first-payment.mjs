// CP1: one real USDT payment from a payer with zero WBT, through the live relayer.
// Usage (local shell, from the repo root):
//   RELAYER_URL=... QUIETPAY_API_KEY=... QUIETPAY_MERCHANT_ID=0x... PAYER_PRIVATE_KEY=0x... \
//   pnpm --filter @quietpay/shared exec tsx scripts/first-payment.mjs
import { privateKeyToAccount } from "viem/accounts";
import { getAddress } from "viem";
import { QUALIFYING_CHAIN_ID, QUALIFYING_USDT, buildCheckoutAuthorization, computePayNonce, getQualifyingDeployment } from "@quietpay/shared";

// Sane ceiling on the relayer fee the payer will sign: 1 USDT (6 decimals).
const MAX_SIGNED_FEE = 1_000_000n;

const { RELAYER_URL, QUIETPAY_API_KEY, QUIETPAY_MERCHANT_ID, PAYER_PRIVATE_KEY } = process.env;
const amount = process.env.AMOUNT ?? "1000000"; // 1 USDT
if (!RELAYER_URL || !QUIETPAY_API_KEY || !QUIETPAY_MERCHANT_ID || !PAYER_PRIVATE_KEY) {
  throw new Error("Set RELAYER_URL, QUIETPAY_API_KEY, QUIETPAY_MERCHANT_ID, PAYER_PRIVATE_KEY");
}
if (!/^[1-9][0-9]{0,77}$/.test(amount)) throw new Error("AMOUNT must be a positive integer in base units");
{
  const u = new URL(RELAYER_URL);
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) {
    throw new Error(`Refusing: RELAYER_URL must be https (http only for localhost/127.0.0.1), got ${u.protocol}//${u.hostname}`);
  }
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
// Verify the relayer's checkout against the qualifying deployment BEFORE signing anything.
{
  const q = getQualifyingDeployment();
  const bad = (m) => {
    throw new Error(`Refusing to sign: ${m}`);
  };
  if (!c || typeof c !== "object") bad("no checkout in the order");
  if (c.chainId !== QUALIFYING_CHAIN_ID) bad(`chainId ${c.chainId} is not ${QUALIFYING_CHAIN_ID}`);
  if (typeof c.router !== "string" || c.router.toLowerCase() !== q.router.toLowerCase()) bad(`router ${c.router} is not the qualifying router ${q.router}`);
  if (typeof c.token !== "string" || c.token.toLowerCase() !== QUALIFYING_USDT.toLowerCase()) bad(`token ${c.token} is not the official USDT`);
  if (c.value !== amount) bad(`checkout value ${c.value} differs from the requested amount ${amount}`);
  if (order.amount !== undefined && order.amount !== amount) bad(`order amount ${order.amount} differs from the requested amount ${amount}`);
  if (typeof c.fee !== "string" || !/^(0|[1-9][0-9]{0,77})$/.test(c.fee)) bad("fee is missing or malformed");
  if (BigInt(c.fee) > MAX_SIGNED_FEE) bad(`fee ${c.fee} exceeds the cap ${MAX_SIGNED_FEE}`);
  if (BigInt(c.fee) >= BigInt(amount)) bad(`fee ${c.fee} is not below the amount`);
  if (typeof c.payout !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(c.payout) || /^0x0+$/.test(c.payout)) bad("payout is missing or zero");
  if (!c.domain || typeof c.domain.name !== "string" || typeof c.domain.version !== "string") bad("domain is missing");
  if (typeof order.id !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(order.id)) bad("order id is malformed");
  if (typeof order.merchantId === "string" && order.merchantId.toLowerCase() !== QUIETPAY_MERCHANT_ID.toLowerCase()) bad("order merchantId differs from QUIETPAY_MERCHANT_ID");
  const expectedNonce = computePayNonce({ merchantId: QUIETPAY_MERCHANT_ID, orderId: order.id, payout: getAddress(c.payout), value: BigInt(amount), fee: BigInt(c.fee) });
  if (typeof c.nonce !== "string" || c.nonce.toLowerCase() !== expectedNonce.toLowerCase()) bad("nonce does not commit to (merchant, order, payout, value, fee)");
}
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
let settled = false;
for (let i = 0; i < 60; i++) {
  const o = await j(await fetch(`${RELAYER_URL}/v1/orders/${order.id}`));
  if (o.status === "settled") {
    console.log("SETTLED", o.explorerUrl ?? o.txHash);
    settled = true; // no process.exit(): on Windows it can trip a libuv assertion with open sockets
    break;
  }
  if (o.status === "failed" || o.status === "expired") throw new Error(`order ${o.status}`);
  await new Promise((r) => setTimeout(r, 1000));
}
if (!settled) throw new Error("timed out");
