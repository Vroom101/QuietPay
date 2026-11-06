import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { recoverTypedDataAddress } from "viem";
import { buildRefundAuthorization, type RefundContext } from "@quietpay/shared";
import { orderSettled } from "@quietpay/shared/fixtures";
import { refund, getRefund, getRefundContext, listRefunds, type RefundOptions } from "../src/index.js";
import type { Hex } from "viem";

const key = ("0x" + "d4".repeat(32)) as Hex;
const signer = privateKeyToAccount(key);
const context: RefundContext = { orderId: orderSettled.id, merchantId: orderSettled.merchantId,
  payer: orderSettled.payer!, refundSigner: signer.address, amountPaid: "25000000", refunded: "5000000",
  refundIndex: 1, refundBalance: "50000000", chainId: orderSettled.checkout.chainId,
  token: orderSettled.checkout.token, router: orderSettled.checkout.router, domain: orderSettled.checkout.domain };
const result = { id: "0x" + "ef".repeat(32), orderId: context.orderId, amount: "20000000", refundIndex: 1,
  status: "pending", txHash: "0x" + "aa".repeat(32), createdAt: 1_800_000_000 };
const opts: RefundOptions = { baseUrl: "https://relayer.test", apiKey: "merchant-key", merchantId: context.merchantId as Hex,
  orderId: context.orderId as Hex, router: context.router as Hex, refundSignerPrivateKey: key, refundIndex: 1, nowSeconds: 1_800_000_000 };
function transport(c = context) {
  const requests: { url: string; init?: RequestInit }[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response(JSON.stringify(String(url).endsWith("refund-context") ? c : String(url).endsWith("/refunds") ? { refunds: [result] } : result), { status: 200 });
  };
  return { requests, fetcher };
}
describe("merchant SDK refunds", () => {
  it("requires a pinned custom token domain and signs with it", async () => {
    const domain = { name: "Test Token", version: "2" };
    const c = { ...context, token: "0x9999999999999999999999999999999999999999", domain };
    const { requests, fetcher } = transport(c);
    await expect(refund({ ...opts, tokenAddress: c.token as Hex, fetch: fetcher })).rejects.toThrow("does not match");
    expect(requests).toHaveLength(1);
    await refund({ ...opts, tokenAddress: c.token as Hex, tokenDomain: domain, fetch: fetcher });
    const body = JSON.parse(String(requests.at(-1)?.init?.body));
    const td = buildRefundAuthorization({ merchantId: c.merchantId as Hex, orderId: c.orderId as Hex,
      payer: c.payer as Hex, refundSigner: signer.address, router: c.router as Hex,
      amount: BigInt(body.amount), refundIndex: BigInt(body.refundIndex), validAfter: BigInt(body.validAfter),
      validBefore: BigInt(body.validBefore), token: c.token as Hex, chainId: c.chainId,
      domainName: domain.name, domainVersion: domain.version });
    expect(await recoverTypedDataAddress({ ...td, signature: body.signature })).toBe(signer.address);
  });
  it("signs the remaining amount with the exact authorization and sends no key", async () => {
    const { requests, fetcher } = transport();
    expect(await refund({ ...opts, fetch: fetcher })).toMatchObject(result);
    const body = JSON.parse(String(requests[1]?.init?.body));
    expect(body).toMatchObject({ orderId: context.orderId, amount: "20000000", refundIndex: 1 });
    expect(requests[1]?.init?.headers).toMatchObject({ authorization: "Bearer merchant-key" });
    expect(JSON.stringify(requests)).not.toContain(key);
    const td = buildRefundAuthorization({ merchantId: context.merchantId as Hex, orderId: context.orderId as Hex,
      payer: context.payer as Hex, refundSigner: signer.address, router: context.router as Hex,
      amount: 20_000_000n, refundIndex: 1n, validAfter: BigInt(body.validAfter), validBefore: BigInt(body.validBefore) });
    expect(await recoverTypedDataAddress({ ...td, signature: body.signature })).toBe(signer.address);
  });
  it.each([
    { router: "0x" + "22".repeat(20) }, { chainId: 1 }, { token: "0x" + "11".repeat(20) },
    { orderId: "0x" + "11".repeat(32) }, { merchantId: "0x" + "11".repeat(32) },
    { refundSigner: "0x" + "11".repeat(20) }, { refundIndex: 2 },
  ])("refuses tampered or stale context %# before submitting", async changed => {
    const { requests, fetcher } = transport({ ...context, ...changed });
    await expect(refund({ ...opts, fetch: fetcher })).rejects.toThrow(/Refund context does not match|Refund key does not match|Refund index changed/);
    expect(requests).toHaveLength(1);
  });
  it("rejects insufficient balance and an excessive amount without posting", async () => {
    const low = transport({ ...context, refundBalance: "1" });
    await expect(refund({ ...opts, fetch: low.fetcher })).rejects.toMatchObject({ code: "insufficient_refund_balance" });
    expect(low.requests).toHaveLength(1);
    const other = transport();
    await expect(refund({ ...opts, amount: "20000001", fetch: other.fetcher })).rejects.toThrow("Invalid refund amount");
    expect(other.requests).toHaveLength(1);
  });
  it("exposes authenticated context and refund status reads", async () => {
    const { requests, fetcher } = transport();
    expect(await getRefundContext({ ...opts, fetch: fetcher })).toMatchObject(context);
    expect(await getRefund({ baseUrl: opts.baseUrl, apiKey: opts.apiKey, refundId: result.id as Hex, fetch: fetcher })).toMatchObject(result);
    expect(await listRefunds({ ...opts, fetch: fetcher })).toEqual([result]);
    expect(requests.every(r => (r.init?.headers as Record<string,string>).authorization === "Bearer merchant-key")).toBe(true);
  });
});
