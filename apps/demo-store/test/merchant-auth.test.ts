import { afterEach, describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { token, type RefundContext } from "@quietpay/shared";
import { orderSettled } from "@quietpay/shared/fixtures";
import * as actualSdk from "@quietpay/merchant-sdk";
import { buildApp } from "../server/app.js";

const merchant = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());
const refundKey = ("0x" + "11".repeat(32)) as `0x${string}`;
const staticToken = "dashboard-test-access-token-at-least-32-characters";
const open: ReturnType<typeof buildApp>[] = [];
afterEach(async () => {
  for (const a of open.splice(0)) await a.close();
});

function setup(opts: { wallets?: string[]; logger?: Writable } = {}) {
  const clock = { t: 1_800_000_000_000 };
  const context = {
    orderId: orderSettled.id, merchantId: orderSettled.merchantId, payer: orderSettled.payer!,
    refundSigner: privateKeyToAccount(refundKey).address, amountPaid: "25000000", refunded: "0", refundIndex: 0,
    refundBalance: "25000000", chainId: token.chainId, token: token.address, router: orderSettled.checkout.router,
    domain: token.eip712Domain,
  } as RefundContext;
  const sdk = { ...actualSdk, getRefundContext: async () => context, listRefunds: async () => [], listOrders: async () => [orderSettled] };
  const app = buildApp(sdk, {
    baseUrl: "http://relayer", apiKey: "server-only-relayer-key", merchantId: orderSettled.merchantId as `0x${string}`,
    webhookSecret: "secret", now: () => clock.t,
    logger: opts.logger ? { stream: opts.logger } : undefined,
    refunds: { dashboardToken: staticToken, router: context.router as `0x${string}`, refundSignerPrivateKey: refundKey, databasePath: ":memory:" },
    merchantAuth: { wallets: opts.wallets ?? [merchant.address], domain: "dash.example", uri: "https://dash.example", chainId: 1874, sessionSeconds: 3600 },
  });
  open.push(app);
  const post = (url: string, payload: unknown, ip = "203.0.113.5") =>
    app.inject({ method: "POST", url, payload: payload as never, remoteAddress: ip });
  const challenge = async (address: string, ip?: string) => {
    const r = await post("/api/merchant/auth/challenge", { address }, ip);
    return { res: r, body: r.json() as { nonce: string; message: string } };
  };
  const login = async (acct = merchant, ip?: string) => {
    const { body } = await challenge(acct.address, ip);
    const signature = await acct.signMessage({ message: body.message });
    const res = await post("/api/merchant/auth/verify", { nonce: body.nonce, signature }, ip);
    return { res, body, signature };
  };
  const orders = (bearer: string) =>
    app.inject({ method: "GET", url: "/api/merchant/orders", headers: { authorization: `Bearer ${bearer}` } });
  return { app, clock, post, challenge, login, orders };
}

describe("feature: merchant signs in with their wallet", () => {
  it("Given an allowed wallet, When it signs the challenge, Then a session token opens the merchant routes", async () => {
    const { login, orders, app } = setup();
    const { res } = await login();
    expect(res.statusCode).toBe(200);
    const s = res.json();
    expect(s.address.toLowerCase()).toBe(merchant.address.toLowerCase());
    expect(s.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await orders(s.token)).statusCode).toBe(200);
    const me = await app.inject({ method: "GET", url: "/api/merchant/auth/me", headers: { authorization: `Bearer ${s.token}` } });
    expect(me.json()).toEqual({ address: merchant.address.toLowerCase(), expiresAt: s.expiresAt });
  });
  it("the challenge is an EIP-4361 style message", async () => {
    const { challenge } = setup();
    const { body } = await challenge(merchant.address.toLowerCase());
    expect(body.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(body.message).toContain("dash.example wants you to sign in with your Ethereum account:\n" + merchant.address + "\n\n");
    expect(body.message).toContain("URI: https://dash.example\nVersion: 1\nChain ID: 1874\nNonce: " + body.nonce + "\nIssued At: ");
    expect(body.message).toMatch(/Expiration Time: \d{4}-\d\d-\d\dT/);
  });
  it("Given a logged-in session, When it logs out, Then the token stops working", async () => {
    const { login, orders, app } = setup();
    const token1 = (await login()).res.json().token;
    const out = await app.inject({ method: "POST", url: "/api/merchant/auth/logout", headers: { authorization: `Bearer ${token1}` } });
    expect(out.statusCode).toBe(200);
    expect((await orders(token1)).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/merchant/auth/me", headers: { authorization: `Bearer ${token1}` } })).statusCode).toBe(401);
  });
  it("the static dashboard token keeps working", async () => {
    const { orders } = setup();
    expect((await orders(staticToken)).statusCode).toBe(200);
  });
  it("auth is off (404) when no wallets are configured", async () => {
    const { post } = setup({ wallets: [] });
    expect((await post("/api/merchant/auth/challenge", { address: merchant.address })).statusCode).toBe(404);
  });
});

describe("attack: merchant wallet login", () => {
  const fail = { error: "sign-in failed" };
  it("nonce reuse: a second verify with the same nonce is refused", async () => {
    const { login, post } = setup();
    const { res, body, signature } = await login();
    expect(res.statusCode).toBe(200);
    const again = await post("/api/merchant/auth/verify", { nonce: body.nonce, signature });
    expect(again.statusCode).toBe(401);
    expect(again.json()).toEqual(fail);
  });
  it("a failed attempt burns the nonce", async () => {
    const { challenge, post } = setup();
    const { body } = await challenge(merchant.address);
    const bad = await stranger.signMessage({ message: body.message });
    expect((await post("/api/merchant/auth/verify", { nonce: body.nonce, signature: bad })).statusCode).toBe(401);
    const good = await merchant.signMessage({ message: body.message });
    expect((await post("/api/merchant/auth/verify", { nonce: body.nonce, signature: good })).statusCode).toBe(401);
  });
  it("a signature over an edited message (other address, nonce or domain) is refused", async () => {
    const { challenge, post } = setup();
    const first = await challenge(merchant.address);
    const edits = [
      first.body.message.replace(merchant.address, stranger.address),
      first.body.message.replace(first.body.nonce, "0".repeat(32)),
      first.body.message.replace("dash.example", "evil.example"),
    ];
    for (const edited of edits) {
      const c = await challenge(merchant.address);
      const sig = await merchant.signMessage({ message: edited });
      const r = await post("/api/merchant/auth/verify", { nonce: c.body.nonce, signature: sig });
      expect(r.statusCode).toBe(401);
      expect(r.json()).toEqual(fail);
    }
  });
  it("a client-supplied message or address is ignored", async () => {
    const { challenge, post } = setup();
    const { body } = await challenge(stranger.address);
    const m = "I am the merchant";
    const sig = await merchant.signMessage({ message: m });
    const r = await post("/api/merchant/auth/verify", { nonce: body.nonce, signature: sig, message: m, address: merchant.address });
    expect(r.statusCode).toBe(401);
  });
  it("a wallet that is not in the allowlist cannot sign in even with a valid signature", async () => {
    const { login } = setup();
    const { res } = await login(stranger);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual(fail);
  });
  it("allowlist oracle: allowed and unknown addresses get the same challenge shape", async () => {
    const { challenge } = setup();
    const a = await challenge(merchant.address);
    const b = await challenge(stranger.address);
    expect(b.res.statusCode).toBe(a.res.statusCode);
    expect(Object.keys(b.body).sort()).toEqual(Object.keys(a.body).sort());
    expect(b.body.message.length).toBe(a.body.message.length);
    expect(b.res.headers["content-type"]).toBe(a.res.headers["content-type"]);
  });
  it("an expired challenge is refused", async () => {
    const { challenge, post, clock } = setup();
    const { body } = await challenge(merchant.address);
    const sig = await merchant.signMessage({ message: body.message });
    clock.t += 5 * 60_000 + 1000;
    const r = await post("/api/merchant/auth/verify", { nonce: body.nonce, signature: sig });
    expect(r.statusCode).toBe(401);
  });
  it("guessed, wrong and malformed session tokens are refused", async () => {
    const { orders, login, app } = setup();
    const real = (await login()).res.json().token as string;
    for (const t of ["", "x", real.slice(0, -1) + (real.endsWith("A") ? "B" : "A"), "A".repeat(43), real + "x"])
      expect((await orders(t)).statusCode).toBe(401);
    const me = await app.inject({ method: "GET", url: "/api/merchant/auth/me" });
    expect(me.statusCode).toBe(401);
  });
  it("a session token stops working after it expires", async () => {
    const { login, orders, clock } = setup();
    const t = (await login()).res.json().token;
    expect((await orders(t)).statusCode).toBe(200);
    clock.t += 3600_000 + 1000;
    expect((await orders(t)).statusCode).toBe(401);
  });
  it("rate limit applies across two addresses sharing an IPv6 /64", async () => {
    const { post } = setup();
    let blocked = 0;
    for (let i = 0; i < 40; i++) {
      const who = i % 2 ? merchant : stranger;
      const r = await post("/api/merchant/auth/challenge", { address: who.address }, `2001:db8:1:2:${i}::${i + 1}`);
      if (r.statusCode === 429) blocked++;
    }
    expect(blocked).toBeGreaterThan(0);
    const other = await post("/api/merchant/auth/challenge", { address: merchant.address }, "2001:db8:9:9::1");
    expect(other.statusCode).toBe(200);
  });
  it("failed verifies count double against the rate limit", async () => {
    const { post } = setup();
    const codes: number[] = [];
    for (let i = 0; i < 20; i++)
      codes.push((await post("/api/merchant/auth/verify", { nonce: "0".repeat(32), signature: "0x" + "00".repeat(65) })).statusCode);
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes.at(-1)).toBe(429);
  });
  it("invalid and huge bodies are rejected", async () => {
    const { post, app } = setup();
    expect((await post("/api/merchant/auth/challenge", { address: "nope" })).statusCode).toBe(400);
    expect((await post("/api/merchant/auth/challenge", {})).statusCode).toBe(400);
    expect((await post("/api/merchant/auth/challenge", { address: ["x"] })).statusCode).toBe(400);
    const huge = await app.inject({ method: "POST", url: "/api/merchant/auth/challenge", payload: { address: "a".repeat(50_000) } });
    expect(huge.statusCode).toBe(413);
    const v = await post("/api/merchant/auth/verify", { nonce: "n".repeat(100), signature: "0x" + "ab".repeat(10_000) });
    expect([401, 413]).toContain(v.statusCode);
    expect((await post("/api/merchant/auth/verify", "garbage")).statusCode).toBeGreaterThanOrEqual(400);
  });
  it("secrets never appear in logs or error bodies", async () => {
    const lines: string[] = [];
    const stream = new Writable({ write(c, _e, cb) { lines.push(String(c)); cb(); } });
    const { login, orders, post } = setup({ logger: stream });
    const { res, signature } = await login();
    const sess = res.json().token as string;
    await orders(sess);
    const bad = await post("/api/merchant/auth/verify", { nonce: "1".repeat(32), signature });
    const all = lines.join("");
    expect(all).not.toContain(sess);
    expect(all).not.toContain(signature);
    expect(bad.body).not.toContain(signature);
  });
});
