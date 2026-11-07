import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { CreditGasTopUpResponse, ErrorCode, GasAccount } from "@quietpay/shared";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import type { NativeTransfer } from "../src/chain.js";
import { MERCHANT_ID, PAYOUT, makeEnv, newOrder, signFor } from "./helpers.js";

const flush = () => new Promise((r) => setTimeout(r, 0));
const auth = { authorization: "Bearer test-key" };
const OTHER_ID = ("0x" + "02".repeat(32)) as Hex;
const OTHER_PAYOUT = "0x3333333333333333333333333333333333333333" as Hex;
const h = (n: number) => ("0x" + n.toString(16).padStart(64, "0")) as Hex;

function setup(cfgOver = {}) {
  const e = makeEnv({ apiKeys: new Map([["test-key", MERCHANT_ID], ["other-key", OTHER_ID]]), ...cfgOver });
  e.chain.getMerchant = (async (id: Hex) =>
    id.toLowerCase() === OTHER_ID ? { ...e.chain.merchant, payout: OTHER_PAYOUT } : e.chain.merchant) as typeof e.chain.getMerchant;
  const app = buildServer(e.svc);
  const seed = (hash: Hex, over: Partial<NativeTransfer> = {}) =>
    e.chain.nativeTransfers.set(hash.toLowerCase(), {
      from: PAYOUT, to: e.chain.relayerAddress, value: 5n * 10n ** 18n, status: "success", blockNumber: 90n, confirmations: 5, chainId: e.cfg.chainId, ...over,
    });
  const credit = (hash: string, key = "test-key") =>
    app.inject({ method: "POST", url: "/v1/merchant/gas/topups", headers: { authorization: `Bearer ${key}` }, payload: { txHash: hash } });
  const account = (key = "test-key") => app.inject({ method: "GET", url: "/v1/merchant/gas", headers: { authorization: `Bearer ${key}` } });
  const pay = async (n: number) => {
    for (let i = 0; i < n; i++) {
      const order = await newOrder(e.svc, "1000000");
      await e.svc.relayPay(await signFor(order, e.clock.t), { ip: "203.0.113." + (i + 1) });
      await flush();
    }
  };
  return { ...e, app, seed, credit, account, pay };
}

describe("gas tank: balance math", () => {
  it("starts empty: zero balance, low, paymentsLeft null (no average yet)", async () => {
    const t = setup();
    const res = await t.account();
    expect(res.statusCode).toBe(200);
    const a = GasAccount.parse(res.json());
    expect(a).toMatchObject({
      merchantId: MERCHANT_ID, relayer: t.chain.relayerAddress, payout: PAYOUT, creditedWei: "0", spentWei: "0", balanceWei: "0",
      lowBalance: true, avgGasPerOrderWei: "0", paymentsLeft: null, minConfirmations: 2, topUps: [],
    });
  });

  it("credits a valid top-up and reports spent == sum of listOrders gasWei", async () => {
    const t = setup();
    await t.pay(3);
    const spent = t.svc.listOrders(MERCHANT_ID).reduce((s, o) => s + BigInt(o.gasWei ?? "0"), 0n);
    expect(spent).toBeGreaterThan(0n);
    t.seed(h(1), { value: 10n ** 18n });
    const res = await t.credit(h(1));
    expect(res.statusCode).toBe(201);
    const body = CreditGasTopUpResponse.parse(res.json());
    expect(body.topUp).toMatchObject({ txHash: h(1), from: PAYOUT, wei: (10n ** 18n).toString(), block: 90 });
    expect(body.topUp.creditedAt).toBe(t.clock.t);
    expect(body.account.creditedWei).toBe((10n ** 18n).toString());
    expect(body.account.spentWei).toBe(spent.toString());
    expect(body.account.balanceWei).toBe((10n ** 18n - spent).toString());
    expect(body.account.avgGasPerOrderWei).toBe((spent / 3n).toString());
    expect(body.account.paymentsLeft).toBe(Number((10n ** 18n - spent) / (spent / 3n)));
    expect(body.account.lowBalance).toBe(false);
    expect(body.account.topUps).toHaveLength(1);
    expect(GasAccount.parse((await t.account()).json())).toEqual(body.account);
  });

  it("accepts a mixed-case hash and stores it lowercase (one credit only)", async () => {
    const t = setup();
    const upper = ("0x" + "AB".repeat(32)) as Hex;
    t.seed(upper);
    expect((await t.credit(upper)).statusCode).toBe(201);
    expect((await t.credit(upper.toLowerCase())).json().error.code).toBe("topup_already_credited");
  });

  it("goes negative when spent exceeds credited (never blocks payments)", async () => {
    const t = setup();
    await t.pay(2);
    t.seed(h(2), { value: 1n });
    const a = GasAccount.parse((await t.credit(h(2))).json().account);
    expect(BigInt(a.balanceWei)).toBeLessThan(0n);
    expect(a.balanceWei.startsWith("-")).toBe(true);
    expect(a.lowBalance).toBe(true);
    expect(a.paymentsLeft).toBe(0);
    // advisory only: a payment still goes through on a negative balance
    const order = await newOrder(t.svc, "1000000");
    const r = await t.svc.relayPay(await signFor(order, t.clock.t), { ip: "198.51.100.9" });
    expect(r.txHash).toBeTruthy();
  });

  it("lowBalance is true below 20 orders of gas and false at exactly 20; paymentsLeft = floor(balance/avg)", async () => {
    const t = setup();
    await t.pay(2);
    const spent = t.svc.listOrders(MERCHANT_ID).reduce((s, o) => s + BigInt(o.gasWei ?? "0"), 0n);
    const avg = spent / 2n;
    expect(spent % 2n).toBe(0n);
    // balance = 20 * avg - 1  => low
    t.seed(h(3), { value: spent + 20n * avg - 1n });
    let a = GasAccount.parse((await t.credit(h(3))).json().account);
    expect(a.balanceWei).toBe((20n * avg - 1n).toString());
    expect(a.lowBalance).toBe(true);
    expect(a.paymentsLeft).toBe(19);
    // +1 => exactly 20 * avg => not low
    t.seed(h(4), { value: 1n });
    a = GasAccount.parse((await t.credit(h(4))).json().account);
    expect(a.balanceWei).toBe((20n * avg).toString());
    expect(a.lowBalance).toBe(false);
    expect(a.paymentsLeft).toBe(20);
  });

  it("with no paid orders: avg 0, paymentsLeft null, not low while balance > 0", async () => {
    const t = setup();
    t.seed(h(5), { value: 7n });
    const a = GasAccount.parse((await t.credit(h(5))).json().account);
    expect(a).toMatchObject({ avgGasPerOrderWei: "0", paymentsLeft: null, lowBalance: false, balanceWei: "7" });
  });

  it("keeps merchants separate", async () => {
    const t = setup();
    t.seed(h(6));
    await t.credit(h(6));
    const other = GasAccount.parse((await t.account("other-key")).json());
    expect(other).toMatchObject({ merchantId: OTHER_ID, payout: OTHER_PAYOUT, creditedWei: "0", topUps: [] });
  });

  it("lists top-ups newest first and caps at 50", async () => {
    const t = setup();
    for (let i = 1; i <= 55; i++) {
      t.clock.t += 1;
      t.seed(h(1000 + i), { value: BigInt(i) });
      expect((await t.credit(h(1000 + i))).statusCode).toBe(201);
    }
    const a = GasAccount.parse((await t.account()).json());
    expect(a.topUps).toHaveLength(50);
    expect(a.topUps[0]!.txHash).toBe(h(1055));
    expect(a.topUps[49]!.txHash).toBe(h(1006));
    expect(a.creditedWei).toBe(String((55 * 56) / 2)); // all 55 are counted, only 50 listed
  });
});

describe("gas tank: rejections", () => {
  const code = (r: { json(): { error: { code: string } } }) => {
    const c = r.json().error.code;
    expect(ErrorCode.safeParse(c).success).toBe(true);
    return c;
  };

  it("unknown / pending tx -> 404 topup_not_found", async () => {
    const t = setup();
    const r = await t.credit(h(9));
    expect(r.statusCode).toBe(404);
    expect(code(r)).toBe("topup_not_found");
  });

  it("too few confirmations -> 409 topup_unconfirmed, then credited once buried", async () => {
    const t = setup();
    t.seed(h(10), { confirmations: 1 });
    const r = await t.credit(h(10));
    expect(r.statusCode).toBe(409);
    expect(code(r)).toBe("topup_unconfirmed");
    t.seed(h(10), { confirmations: 2 });
    expect((await t.credit(h(10))).statusCode).toBe(201);
  });

  it("honours GAS_TOPUP_MIN_CONFIRMATIONS", async () => {
    const t = setup({ gasTopupMinConfirmations: 10 });
    t.seed(h(11), { confirmations: 9 });
    expect((await t.credit(h(11))).json().error.code).toBe("topup_unconfirmed");
    expect(GasAccount.parse((await t.account()).json()).minConfirmations).toBe(10);
  });

  it.each([
    ["reverted", { status: "reverted" as const }],
    ["wrong recipient", { to: "0x5555555555555555555555555555555555555555" as Hex }],
    ["contract creation (no recipient)", { to: null }],
    ["zero value", { value: 0n }],
    ["wrong chain", { chainId: 1 }],
  ])("%s -> 422 topup_invalid", async (_n, over) => {
    const t = setup();
    t.seed(h(12), over);
    const r = await t.credit(h(12));
    expect(r.statusCode).toBe(422);
    expect(code(r)).toBe("topup_invalid");
    expect(GasAccount.parse((await t.account()).json()).creditedWei).toBe("0");
  });

  it("recipient match is case-insensitive", async () => {
    const t = setup();
    t.seed(h(13), { to: t.chain.relayerAddress.toUpperCase().replace("0X", "0x") as Hex });
    expect((await t.credit(h(13))).statusCode).toBe(201);
  });

  it("not from the merchant's payout -> 403 topup_wrong_sender", async () => {
    const t = setup();
    t.seed(h(14), { from: "0x6666666666666666666666666666666666666666" as Hex });
    const r = await t.credit(h(14));
    expect(r.statusCode).toBe(403);
    expect(code(r)).toBe("topup_wrong_sender");
  });

  it("sender match is case-insensitive", async () => {
    const t = setup();
    t.seed(h(15), { from: PAYOUT.toUpperCase().replace("0X", "0x") as Hex });
    expect((await t.credit(h(15))).statusCode).toBe(201);
  });

  it("duplicate by the same merchant -> 409 topup_already_credited, balance unchanged", async () => {
    const t = setup();
    t.seed(h(16), { value: 100n });
    expect((await t.credit(h(16))).statusCode).toBe(201);
    const r = await t.credit(h(16));
    expect(r.statusCode).toBe(409);
    expect(code(r)).toBe("topup_already_credited");
    expect(GasAccount.parse((await t.account()).json()).creditedWei).toBe("100");
  });

  it("the same hash claimed by another merchant -> topup_already_credited, and nothing is credited to them", async () => {
    const t = setup();
    t.seed(h(17), { value: 100n });
    expect((await t.credit(h(17))).statusCode).toBe(201);
    t.seed(h(17), { value: 100n, from: OTHER_PAYOUT }); // even if it also looks like theirs
    const r = await t.credit(h(17), "other-key");
    expect(r.statusCode).toBe(409);
    expect(code(r)).toBe("topup_already_credited");
    expect(GasAccount.parse((await t.account("other-key")).json()).creditedWei).toBe("0");
    expect(GasAccount.parse((await t.account()).json()).creditedWei).toBe("100");
  });

  it("two concurrent claims credit exactly once (INSERT OR IGNORE)", async () => {
    const t = setup();
    t.seed(h(18), { value: 100n });
    const rs = await Promise.all([t.credit(h(18)), t.credit(h(18))]);
    expect(rs.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(GasAccount.parse((await t.account()).json()).creditedWei).toBe("100");
  });

  it("malformed hash / body -> 4xx, never credited", async () => {
    const t = setup();
    for (const payload of [{ txHash: "0x12" }, {}, { txHash: 5 }]) {
      const r = await t.app.inject({ method: "POST", url: "/v1/merchant/gas/topups", headers: auth, payload });
      expect(r.statusCode).toBe(400);
    }
  });
});

describe("gas tank: auth", () => {
  it("requires an API key on both routes", async () => {
    const t = setup();
    for (const [method, url] of [["GET", "/v1/merchant/gas"], ["POST", "/v1/merchant/gas/topups"]] as const) {
      const none = await t.app.inject({ method, url, payload: method === "POST" ? { txHash: h(1) } : undefined });
      expect(none.statusCode).toBe(401);
      const bad = await t.app.inject({ method, url, headers: { authorization: "Bearer nope" }, payload: method === "POST" ? { txHash: h(1) } : undefined });
      expect(bad.statusCode).toBe(401);
    }
  });

  it("the operator token is not a merchant key", async () => {
    const t = setup();
    const r = await t.app.inject({ method: "GET", url: "/v1/merchant/gas", headers: { authorization: `Bearer ${t.cfg.operatorToken}` } });
    expect(r.statusCode).toBe(401);
  });
});

describe("gas tank: config", () => {
  const env = {
    RPC_URL: "http://localhost:8545", USDT_ADDRESS: "0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7",
    ROUTER_ADDRESS: "0x0000000000000000000000000000000000000001", RELAYER_PRIVATE_KEY: "0x" + "b2".repeat(32),
    OPERATOR_TOKEN: "operator-token-123456", MERCHANT_API_KEYS: "k".repeat(24) + ":0x" + "01".repeat(32), WEBHOOK_SECRET: "w".repeat(20),
  };
  it("GAS_TOPUP_MIN_CONFIRMATIONS defaults to 2 and is bounded 1..1000", () => {
    // router check happens after the schema parse; only the schema bounds are asserted here
    const parse = (v?: string) => { try { return loadConfig({ ...env, ...(v ? { GAS_TOPUP_MIN_CONFIRMATIONS: v } : {}) }).gasTopupMinConfirmations; } catch (e) { return String((e as Error).message); } };
    expect(String(parse("0"))).toMatch(/GAS_TOPUP_MIN_CONFIRMATIONS/);
    expect(String(parse("1001"))).toMatch(/GAS_TOPUP_MIN_CONFIRMATIONS/);
    expect(String(parse("abc"))).toMatch(/GAS_TOPUP_MIN_CONFIRMATIONS/);
    // in-range values are not rejected by the schema (any error left is the unrelated router check)
    expect(String(parse())).not.toMatch(/GAS_TOPUP_MIN_CONFIRMATIONS/);
    expect(String(parse("1000"))).not.toMatch(/GAS_TOPUP_MIN_CONFIRMATIONS/);
  });
});
