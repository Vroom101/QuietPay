// One small REAL gasless payment straight through the relayer API (no browser): 1 USDT by default, official USDT,
// chain 1874. Used to put a real order (with real relayer gas) on the merchant dashboard.
//   node --env-file=<gitignored env> deploy/pay-small-real.mjs [amountBaseUnits]
// Needs PAYER_PRIVATE_KEY, MERCHANT_API_KEY. Refuses more than 2 USDT. Nothing from the env is printed.
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RELAYER = process.env.RELAYER_URL ?? "http://127.0.0.1:8790";
const amount = BigInt(process.argv[2] ?? "1000000");
if (amount <= 0n || amount > 2_000_000n) { console.error("amount must be 1..2000000 base units (max 2 USDT)"); process.exit(1); }
const q = JSON.parse(readFileSync(resolve(root, "contracts/deployments.json"), "utf8"))["1874"];
if (q?.qualifying !== true) throw new Error("no qualifying deployment");
const merchantId = Object.values(q.merchants)[0].merchantId;
const payer = privateKeyToAccount(process.env.PAYER_PRIVATE_KEY);
const j = async (r) => { const b = await r.json(); if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(b).slice(0, 200)}`); return b; };

const order = await j(await fetch(`${RELAYER}/v1/orders`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${process.env.MERCHANT_API_KEY}` }, body: JSON.stringify({ merchantId, amount: amount.toString(), reference: "small-real-payment" }) }));
const c = order.checkout;
if (c.chainId !== 1874 || c.token.toLowerCase() !== q.token.toLowerCase() || c.router.toLowerCase() !== q.router.toLowerCase()) throw new Error("order is not for the qualifying deployment");
const now = Math.floor(Date.now() / 1000);
const validAfter = now - 30, validBefore = now + 540; // the relayer allows a window of at most 10 minutes
const signature = await payer.signTypedData({
  domain: { name: c.domain.name, version: c.domain.version, chainId: c.chainId, verifyingContract: c.token },
  types: { ReceiveWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
  primaryType: "ReceiveWithAuthorization",
  message: { from: payer.address, to: c.router, value: BigInt(c.value), validAfter: BigInt(validAfter), validBefore: BigInt(validBefore), nonce: c.nonce },
});
const relayed = await j(await fetch(`${RELAYER}/v1/relay/pay`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orderId: order.id, payer: payer.address, validAfter, validBefore, signature, amount: amount.toString() }) }));
console.log("relayed", relayed.status, relayed.txHash ?? "");
for (let i = 0; i < 60; i++) {
  const o = await j(await fetch(`${RELAYER}/v1/orders/${order.id}`));
  if (o.status === "settled") { console.log("settled", o.explorerUrl ?? o.txHash); process.exit(0); }
  if (["failed", "expired"].includes(o.status)) { console.log("ended", o.status); process.exit(1); }
  await new Promise((r) => setTimeout(r, 2000));
}
console.log("timed out waiting for settlement"); process.exit(1);
