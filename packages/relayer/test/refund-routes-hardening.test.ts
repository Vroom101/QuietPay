import { describe, expect, it } from "vitest";
import { buildRefundAuthorization, type RelayRefundRequest } from "@quietpay/shared";
import { clientKey } from "../src/ratelimit.js";
import { buildServer } from "../src/server.js";
import { makeEnv, newOrder, signFor, MERCHANT_ID, refundSigner, payer, ROUTER } from "./helpers.js";
import type { Hex } from "viem";

const flush = () => new Promise(r => setTimeout(r, 0));
async function setup() {
  const e = makeEnv();
  const order = await newOrder(e.svc, "25000000", { webhookUrl: "https://merchant.test/hook" });
  await e.svc.relayPay(await signFor(order, e.clock.t), { ip: "203.0.113.1" });
  await flush();
  return { ...e, order };
}
async function signed(e: Awaited<ReturnType<typeof setup>>, index: number): Promise<RelayRefundRequest> {
  const amount = "1000", validAfter = e.clock.t - 5, validBefore = e.clock.t + 300;
  const signature = await refundSigner.signTypedData(buildRefundAuthorization({ merchantId: MERCHANT_ID,
    orderId: e.order.id as Hex, payer: payer.address, refundSigner: refundSigner.address, router: ROUTER,
    amount: BigInt(amount), refundIndex: BigInt(index), validAfter: BigInt(validAfter), validBefore: BigInt(validBefore), token: e.cfg.usdt, chainId: e.cfg.chainId, domainName: e.cfg.tokenDomain.name, domainVersion: e.cfg.tokenDomain.version }));
  return { orderId: e.order.id, amount, refundIndex: index, validAfter, validBefore, signature } as RelayRefundRequest;
}
const auth = { authorization: "Bearer test-key" };

describe("refund route hardening", () => {
  it("rate-limits refund-context per client and stops chain reads", async () => {
    const e = await setup(), app = buildServer(e.svc);
    let reads = 0;
    const orig = e.chain.getOrderReceipt.bind(e.chain);
    e.chain.getOrderReceipt = async (...a: Parameters<typeof orig>) => { reads++; return orig(...a); };
    const codes: number[] = [];
    for (let i = 0; i < 70; i++) codes.push((await app.inject({ url: `/v1/orders/${e.order.id}/refund-context`, headers: auth, remoteAddress: "198.51.100.7" })).statusCode);
    expect(codes.filter(c => c === 200).length).toBeLessThanOrEqual(60);
    expect(codes.slice(-1)[0]).toBe(429);
    expect(reads).toBeLessThanOrEqual(60);
    const before = reads;
    await app.inject({ url: `/v1/orders/${e.order.id}/refund-context`, headers: auth, remoteAddress: "198.51.100.7" });
    expect(reads).toBe(before);
  });

  it("shares one submit limit across an IPv6 /64", async () => {
    const e = makeEnv({ rateLimitPerMinute: 1 });
    const order = await newOrder(e.svc, "25000000", { webhookUrl: "https://merchant.test/hook" });
    await e.svc.relayPay(await signFor(order, e.clock.t), { ip: "203.0.113.1" });
    await flush();
    const env = { ...e, order } as Awaited<ReturnType<typeof setup>>;
    await e.svc.refunds.submit(MERCHANT_ID, await signed(env, 0), "2001:db8:1:2::1");
    // The ip bucket (not the merchant bucket) must already be spent for every address in that /64.
    const lim = (e.svc.refunds as unknown as { limiter: { wouldAllow(k: string): boolean } }).limiter;
    expect(lim.wouldAllow("ip:" + clientKey("2001:db8:1:2:ffff::9"))).toBe(false);
    expect(lim.wouldAllow("ip:" + clientKey("2001:db8:9:9::1"))).toBe(true);
  });

  it("still serves a valid key and hides other merchants' orders", async () => {
    const e = await setup(), app = buildServer(e.svc);
    const ok = await app.inject({ url: `/v1/orders/${e.order.id}/refund-context`, headers: auth });
    expect(ok.statusCode).toBe(200);
    e.cfg.apiKeys.set("foreign", ("0x" + "02".repeat(32)) as Hex);
    const other = await app.inject({ url: `/v1/orders/${e.order.id}/refund-context`, headers: { authorization: "Bearer foreign" } });
    expect(other.statusCode).toBe(404);
    expect(other.json().error.code).toBe("order_not_found");
    expect((await app.inject({ url: `/v1/orders/${e.order.id}/refund-context` })).statusCode).toBe(401);
  });
});
