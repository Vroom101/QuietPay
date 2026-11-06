import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { buildCheckoutAuthorization, computePayNonce, computeRefundNonce, type Order } from "@quietpay/shared";
import { createOrder, getOrder, listRefunds, refund as sdkRefund, getRefundContext, QuietpayApiError, verifyWebhook, type Refund } from "@quietpay/merchant-sdk";
import { ERC20, type Stack, type Tenant } from "./stack.js";
import { waitUntil } from "./util.js";

const nowS = () => Math.floor(Date.now() / 1000);

/** Merchant creates an order through the SDK. */
export function newOrder(s: Stack, amount: bigint, o: { tenant?: Tenant; hook?: boolean; reference?: string } = {}) {
  const t = o.tenant ?? s.tenant;
  return createOrder({
    baseUrl: s.relayerUrl, apiKey: t.apiKey, merchantId: t.merchantId, amount: amount.toString(),
    reference: o.reference, webhookUrl: o.hook === false ? undefined : s.sink.url,
  });
}

export const read = (s: Stack, id: Hex) => getOrder({ baseUrl: s.relayerUrl, orderId: id });

export interface PaySig { orderId: Hex; payer: Address; validAfter: number; validBefore: number; signature: Hex; amount?: string }

/** The payer signs the order's typed data with the shared helper (never new signing code). */
export async function signPay(order: Order, payerKey: Hex, o: { validFor?: number; payerAddress?: Address } = {}): Promise<PaySig> {
  const acct = privateKeyToAccount(payerKey);
  const validAfter = nowS() - 30;
  const validBefore = nowS() + (o.validFor ?? 300);
  const signature = await acct.signTypedData(
    buildCheckoutAuthorization({
      from: o.payerAddress ?? acct.address, router: order.checkout.router as Address, value: BigInt(order.amount), nonce: order.checkout.nonce as Hex,
      validAfter: BigInt(validAfter), validBefore: BigInt(validBefore), chainId: order.checkout.chainId, token: order.checkout.token as Address,
      domainName: order.checkout.domain.name, domainVersion: order.checkout.domain.version,
    }),
  );
  return { orderId: order.id as Hex, payer: o.payerAddress ?? acct.address, validAfter, validBefore, signature };
}

export interface HttpResult<T = any> { status: number; json: T }
export async function post<T = any>(url: string, body: unknown, apiKey?: string): Promise<HttpResult<T>> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) }, body: JSON.stringify(body) });
  const text = await r.text();
  let json: unknown = text;
  try { json = JSON.parse(text); } catch { /* keep text */ }
  return { status: r.status, json: json as T };
}
export async function get<T = any>(url: string, apiKey?: string): Promise<HttpResult<T>> {
  const r = await fetch(url, { headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {} });
  const text = await r.text();
  let json: unknown = text;
  try { json = JSON.parse(text); } catch { /* keep text */ }
  return { status: r.status, json: json as T };
}

export const relayPay = (s: Stack, sig: PaySig) => post<{ orderId: Hex; status: string; txHash?: Hex; error?: { code: string } }>(`${s.relayerUrl}/v1/relay/pay`, sig);

export async function waitStatus(s: Stack, id: Hex, want: string[], timeoutMs = 60_000): Promise<Order> {
  return waitUntil(async () => {
    const o = await read(s, id);
    if (!want.includes(o.status) && (o.status === "failed" || o.status === "expired")) throw new Error(`order ${id} became ${o.status} (${o.failureCode ?? ""})`);
    return want.includes(o.status) ? o : undefined;
  }, `order ${id} to be ${want.join("/")}`, timeoutMs, 400);
}

/** Full happy path: create, sign, relay, wait for settled. */
export async function payOrder(s: Stack, amount: bigint, payerKey: Hex, o: { hook?: boolean; reference?: string } = {}) {
  const order = await newOrder(s, amount, o);
  const sig = await signPay(order, payerKey);
  const r = await relayPay(s, sig);
  if (r.status !== 200) throw new Error(`relay/pay answered ${r.status} ${JSON.stringify(r.json)}`);
  const settled = await waitStatus(s, order.id as Hex, ["settled"]);
  return { order, settled, sig, txHash: r.json.txHash as Hex };
}

/** Refund through the SDK helper (it signs with buildRefundAuthorization). */
export async function doRefund(s: Stack, orderId: Hex, refundIndex: number, amount?: bigint, t: Tenant = s.tenant): Promise<Refund> {
  const r = await sdkRefund({
    baseUrl: s.relayerUrl, apiKey: t.apiKey, merchantId: t.merchantId, orderId, router: s.router, refundSignerPrivateKey: t.refundKey,
    refundIndex, amount: amount?.toString(), chainId: s.chainId, tokenAddress: s.usdt,
  });
  return waitRefund(s, orderId, r.id as Hex, t);
}

export async function waitRefund(s: Stack, orderId: Hex, refundId: Hex, t: Tenant = s.tenant): Promise<Refund> {
  return waitUntil(async () => {
    const list = await listRefunds({ baseUrl: s.relayerUrl, apiKey: t.apiKey, orderId });
    const r = list.find((x) => x.id.toLowerCase() === refundId.toLowerCase());
    if (r?.status === "failed") throw new Error(`refund ${refundId} failed (${r.failureCode ?? ""})`);
    return r?.status === "settled" ? r : undefined;
  }, `refund ${refundId} to settle`, 60_000, 400);
}

/** Reports the error code an SDK call fails with, or undefined if it succeeds. */
export async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try { await p; return undefined; } catch (e) { return e instanceof QuietpayApiError ? e.code : `local:${(e as Error).message}`; }
}

/** Counts the router's Paid / Refunded logs for an order straight from the chain. */
export async function chainEventCount(s: Stack, orderId: Hex, kind: "Paid" | "Refunded"): Promise<number> {
  const logs = await s.pub.getLogs({ address: s.router, fromBlock: 0n, toBlock: "latest" });
  const { paymentRouterAbi } = await import("@quietpay/shared");
  const { decodeEventLog } = await import("viem");
  let n = 0;
  for (const l of logs) {
    try {
      const d = decodeEventLog({ abi: paymentRouterAbi, data: l.data, topics: l.topics });
      if (d.eventName === kind && String((d.args as { orderId?: string }).orderId).toLowerCase() === orderId.toLowerCase()) n += 1;
    } catch { /* not ours */ }
  }
  return n;
}

export async function nonceUsed(s: Stack, payer: Address, order: Order): Promise<boolean> {
  const nonce = computePayNonce({ merchantId: order.merchantId as Hex, orderId: order.id as Hex, payout: order.payout as Address, value: BigInt(order.amount), fee: BigInt(order.fee) });
  if (nonce.toLowerCase() !== order.checkout.nonce.toLowerCase()) throw new Error("checkout nonce differs from computePayNonce");
  return s.pub.readContract({ address: s.usdt, abi: ERC20, functionName: "authorizationState", args: [payer, nonce] }) as Promise<boolean>;
}

export async function refundNonceUsed(s: Stack, orderId: Hex, payer: Address, amount: bigint, index: number, t: Tenant = s.tenant): Promise<boolean> {
  const nonce = computeRefundNonce({ merchantId: t.merchantId, orderId, payer, amount, refundIndex: index });
  return s.pub.readContract({ address: s.usdt, abi: ERC20, functionName: "authorizationState", args: [t.refundSigner, nonce] }) as Promise<boolean>;
}

/** Parses the sink's captured deliveries with the SDK verifier. */
export function verifyHit(s: Stack, t: Tenant, hit: { body: string; sig: string }, over: { nowSeconds?: number } = {}) {
  return verifyWebhook({ secret: s.webhookSecretOf(t), body: hit.body, signatureHeader: hit.sig, nowSeconds: over.nowSeconds });
}

export { getRefundContext, listRefunds, QuietpayApiError };

/** Builds a refund POST body signed with `key` (any key: the relayer must verify it) via buildRefundAuthorization. */
export async function signedRefundBody(s: Stack, orderId: Hex, amount: bigint, refundIndex: number, key: Hex, t: Tenant = s.tenant, over: { validFor?: number } = {}) {
  const c = await getRefundContext({ baseUrl: s.relayerUrl, apiKey: t.apiKey, orderId });
  const acct = privateKeyToAccount(key);
  const validAfter = nowS() - 5;
  const validBefore = nowS() + (over.validFor ?? 300);
  const { buildRefundAuthorization } = await import("@quietpay/shared");
  const signature = await acct.signTypedData(buildRefundAuthorization({
    merchantId: t.merchantId, orderId, payer: c.payer as Address, refundSigner: acct.address, router: c.router as Address,
    amount, refundIndex: BigInt(refundIndex), validAfter: BigInt(validAfter), validBefore: BigInt(validBefore),
    chainId: c.chainId, token: c.token as Address, domainName: c.domain.name, domainVersion: c.domain.version,
  }));
  return { orderId, amount: amount.toString(), refundIndex, validAfter, validBefore, signature };
}

export const postRefund = (s: Stack, body: unknown, t: Tenant = s.tenant) => post<any>(`${s.relayerUrl}/v1/relay/refund`, body, t.apiKey);

export const errCode = (r: HttpResult) => (r.json as { error?: { code?: string } })?.error?.code;
