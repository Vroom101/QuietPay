/**
 * Round 6 coverage: TRUST_PROXY_HOPS client-address derivation, config parsing, and new-wallet slot bookkeeping.
 */
import { describe, expect, it } from "vitest";
import { resolveClientIp, clientKey } from "../src/ratelimit.js";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { makeEnv, newOrder } from "./helpers.js";
import { privateKeyToAccount } from "viem/accounts";
import { buildCheckoutAuthorization, QUALIFYING_USDT, getQualifyingDeployment } from "@quietpay/shared";
import type { Hex } from "viem";

describe("round 6: resolveClientIp", () => {
  const sock = "10.9.9.9";
  it("hops=0 (default) ignores a spoofed X-Forwarded-For", () => {
    expect(resolveClientIp(sock, "1.2.3.4", 0)).toBe(sock);
    expect(resolveClientIp(sock, "1.2.3.4, 5.6.7.8", 0)).toBe(sock);
  });
  it("hops=1 uses the rightmost entry", () => {
    expect(resolveClientIp(sock, "198.51.100.5", 1)).toBe("198.51.100.5");
    expect(resolveClientIp(sock, "6.6.6.6, 198.51.100.5", 1)).toBe("198.51.100.5");
  });
  it("a client-spoofed leftmost entry cannot change the key", () => {
    const a = resolveClientIp(sock, "1.1.1.1, 198.51.100.5", 1);
    const b = resolveClientIp(sock, "9.9.9.9, 8.8.8.8, 198.51.100.5", 1);
    expect(clientKey(a)).toBe(clientKey(b));
    expect(a).toBe("198.51.100.5");
    // hops=2: the second from the right, still ignoring anything further left.
    expect(resolveClientIp(sock, "7.7.7.7, 198.51.100.5, 10.0.0.1", 2)).toBe("198.51.100.5");
  });
  it("short, empty or malformed headers fall back to the socket address", () => {
    expect(resolveClientIp(sock, undefined, 1)).toBe(sock);
    expect(resolveClientIp(sock, "", 1)).toBe(sock);
    expect(resolveClientIp(sock, "198.51.100.5", 2)).toBe(sock);
    expect(resolveClientIp(sock, "not-an-ip", 1)).toBe(sock);
    expect(resolveClientIp(sock, "198.51.100.5, ", 1)).toBe(sock);
    expect(resolveClientIp(sock, "1.2.3.4, 999.1.1.1", 1)).toBe(sock);
  });
  it("accepts IPv6 entries", () => {
    expect(resolveClientIp(sock, "x, 2001:db8::1", 1)).toBe("2001:db8::1");
  });
});

describe("round 6: TRUST_PROXY_HOPS over HTTP", () => {
  async function hit(hops: number, remote: string, xff: (i: number) => string) {
    const { svc } = makeEnv({ trustProxyHops: hops });
    const app = buildServer(svc);
    const codes: number[] = [];
    for (let i = 0; i < 70; i++) {
      const r = await app.inject({ method: "GET", url: "/v1/health", remoteAddress: remote, headers: { "x-forwarded-for": xff(i) } });
      codes.push(r.statusCode);
    }
    return codes.filter((c) => c === 429).length;
  }
  it("default 0: rotating spoofed XFF does not evade the limiter", async () => {
    expect(await hit(0, "198.51.100.9", (i) => `10.0.0.${i + 1}`)).toBeGreaterThan(0);
  });
  it("hops=1: rotating a spoofed leftmost entry does not evade the limiter", async () => {
    expect(await hit(1, "10.9.9.9", (i) => `10.0.0.${i + 1}, 203.0.113.4`)).toBeGreaterThan(0);
  });
  it("hops=1: distinct real clients behind one proxy get separate limits", async () => {
    expect(await hit(1, "10.9.9.9", (i) => `203.0.113.${i + 1}`)).toBe(0);
  });
  it("hops=1 with no header falls back to the socket address", async () => {
    const { svc } = makeEnv({ trustProxyHops: 1 });
    const app = buildServer(svc);
    let limited = 0;
    for (let i = 0; i < 70; i++) {
      if ((await app.inject({ method: "GET", url: "/v1/health", remoteAddress: "198.51.100.9" })).statusCode === 429) limited++;
    }
    expect(limited).toBeGreaterThan(0);
  });
});

describe("round 6: TRUST_PROXY_HOPS config", () => {
  const base = {
    RPC_URL: "http://localhost:8545",
    USDT_ADDRESS: QUALIFYING_USDT,
    ROUTER_ADDRESS: getQualifyingDeployment().router,
    RELAYER_PRIVATE_KEY: "0x" + "33".repeat(32),
    OPERATOR_TOKEN: "operator-token-123456",
    MERCHANT_API_KEYS: "merchant-key-0123456789abcdef:0x" + "01".repeat(32),
    WEBHOOK_SECRET: "whsec_0123456789abcdef",
  };
  it("defaults to 0 and parses integers; rejects negatives and non-integers", () => {
    expect(loadConfig(base).trustProxyHops).toBe(0);
    expect(loadConfig({ ...base, TRUST_PROXY_HOPS: "1" }).trustProxyHops).toBe(1);
    expect(() => loadConfig({ ...base, TRUST_PROXY_HOPS: "-1" })).toThrow();
    expect(() => loadConfig({ ...base, TRUST_PROXY_HOPS: "1.5" })).toThrow();
  });
});

describe("round 6: new-wallet slot bookkeeping", () => {
  it("failed relays leave no per-IP entry behind (memory does not grow with distinct /64s)", async () => {
    const { svc, chain, clock } = makeEnv();
    chain.simulateFails = true;
    for (let i = 0; i < 5; i++) {
      const key = ("0x" + (0x70 + i).toString(16).repeat(32)) as Hex;
      const acct = privateKeyToAccount(key);
      const o = await newOrder(svc);
      const validAfter = clock.t - 5;
      const validBefore = clock.t + 300;
      const signature = await acct.signTypedData(
        buildCheckoutAuthorization({
          from: acct.address, router: o.checkout.router as Hex, value: BigInt(o.amount), nonce: o.checkout.nonce as Hex,
          validAfter: BigInt(validAfter), validBefore: BigInt(validBefore), chainId: o.checkout.chainId, token: o.checkout.token as Hex,
        }),
      );
      await svc.relayPay({ orderId: o.id, payer: acct.address, validAfter, validBefore, signature }, { ip: `2001:db8:${i}::1` }).catch(() => {});
    }
    const priv = svc as unknown as { newPayersByIp: Map<string, unknown>; slotHolders: Map<string, unknown> };
    expect(priv.newPayersByIp.size).toBe(0);
    expect(priv.slotHolders.size).toBe(0);
  });
});
