import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerGasTank, type GasAccount, type GasSdk, type GasTankConfig } from "../server/gas-tank.js";

const TOKEN = "t".repeat(40);
const KEY = "merchant-api-key";
const HASH = "0x" + "ab".repeat(32);
const account: GasAccount = {
  merchantId: "m1", relayer: "0x" + "11".repeat(20), payout: "0x" + "22".repeat(20), creditedWei: "5000000000000000000", spentWei: "1000000000000000000",
  balanceWei: "4000000000000000000", lowBalance: false, avgGasPerOrderWei: "1000000000000000", paymentsLeft: 4000, minConfirmations: 2, topUps: [],
};
const topUp = { txHash: HASH, from: account.payout, wei: "5000000000000000000", block: 10, creditedAt: 1700000000 };

class ApiErr extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

function make(sdk: GasSdk | undefined = {}, over: Partial<GasTankConfig> = {}) {
  const app = Fastify();
  const getGasAccount = vi.fn(async () => account);
  const creditGasTopUp = vi.fn(async () => ({ topUp, account }));
  const impl: GasSdk = sdk === undefined ? {} : { getGasAccount, creditGasTopUp, ...sdk };
  registerGasTank(app, impl, { baseUrl: "http://relayer.test", apiKey: KEY, dashboardToken: TOKEN, acceptSession: (t) => t === "session-ok", ...over });
  return { app, impl, getGasAccount, creditGasTopUp };
}
const auth = (a?: string) => (a ? { authorization: `Bearer ${a}` } : {});
const get = (app: ReturnType<typeof Fastify>, a?: string) => app.inject({ method: "GET", url: "/api/merchant/gas", headers: auth(a) });
const post = (app: ReturnType<typeof Fastify>, body: unknown, ...rest: [string?]) =>
  app.inject({ method: "POST", url: "/api/merchant/gas/topups", headers: auth(rest.length ? rest[0] : TOKEN), payload: body as object });

describe("gas tank proxy", () => {
  it("returns the gas account, sending the API key only upstream", async () => {
    const { app, getGasAccount } = make();
    const r = await get(app, TOKEN);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual(account);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(getGasAccount).toHaveBeenCalledWith({ baseUrl: "http://relayer.test", apiKey: KEY });
    expect(r.body).not.toContain(KEY);
  });

  it("accepts a wallet session", async () => {
    expect((await get(make().app, "session-ok")).statusCode).toBe(200);
  });

  it.each([undefined, "wrong", KEY, ""])("refuses credential %s without calling upstream", async (a) => {
    const { app, getGasAccount, creditGasTopUp } = make();
    expect((await get(app, a)).statusCode).toBe(401);
    expect((await post(app, { txHash: HASH }, a)).statusCode).toBe(401);
    expect(getGasAccount).not.toHaveBeenCalled();
    expect(creditGasTopUp).not.toHaveBeenCalled();
  });

  it("credits a top-up and answers 201", async () => {
    const { app, creditGasTopUp } = make();
    const r = await post(app, { txHash: HASH });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toEqual({ topUp, account });
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(creditGasTopUp).toHaveBeenCalledWith({ baseUrl: "http://relayer.test", apiKey: KEY, txHash: HASH });
  });

  it.each([undefined, {}, { txHash: 5 }, { txHash: "0x1234" }, { txHash: "0x" + "g".repeat(64) }, { txHash: HASH + "00" }, { txHash: [HASH] }])(
    "rejects invalid body %j with 400 and no upstream call",
    async (body) => {
      const { app, creditGasTopUp } = make();
      const r = await post(app, body ?? {});
      expect(r.statusCode).toBe(400);
      expect(r.json().error.code).toBe("invalid_request");
      expect(creditGasTopUp).not.toHaveBeenCalled();
    },
  );

  it.each([
    [404, "topup_not_found"], [409, "topup_unconfirmed"], [422, "topup_invalid"], [403, "topup_wrong_sender"], [409, "topup_already_credited"],
  ])("maps upstream %i %s through", async (status, code) => {
    const { app } = make({ creditGasTopUp: async () => { throw new ApiErr(status, code, "upstream says no"); } });
    const r = await post(app, { txHash: HASH });
    expect(r.statusCode).toBe(status);
    expect(r.json()).toEqual({ error: { code, message: "upstream says no" } });
  });

  it("answers 502 for unknown upstream failures on both routes, without leaking details", async () => {
    const boom = async () => { throw new Error("connect ECONNREFUSED 10.0.0.1 " + KEY); };
    const { app } = make({ getGasAccount: boom, creditGasTopUp: boom });
    for (const r of [await get(app, TOKEN), await post(app, { txHash: HASH })]) {
      expect(r.statusCode).toBe(502);
      expect(r.body).not.toContain("ECONNREFUSED");
      expect(r.body).not.toContain(KEY);
    }
    const unknown = make({ getGasAccount: async () => { throw new ApiErr(500, "unknown", "x"); } });
    expect((await get(unknown.app, TOKEN)).statusCode).toBe(502);
    const unauth = make({ getGasAccount: async () => { throw new ApiErr(401, "unauthorized", "bad key"); } });
    expect((await get(unauth.app, TOKEN)).statusCode).toBe(502);
  });

  it("answers 503 gas_not_configured when the SDK lacks the functions", async () => {
    const app = Fastify();
    registerGasTank(app, {}, { baseUrl: "http://relayer.test", apiKey: KEY, dashboardToken: TOKEN });
    for (const r of [await get(app, TOKEN), await post(app, { txHash: HASH })]) {
      expect(r.statusCode).toBe(503);
      expect(r.json().error.code).toBe("gas_not_configured");
    }
  });

  it("rate limits top-ups per credential", async () => {
    let t = 0;
    const { app, creditGasTopUp } = make({}, { now: () => t });
    for (let i = 0; i < 10; i++) expect((await post(app, { txHash: HASH })).statusCode).toBe(201);
    const r = await post(app, { txHash: HASH });
    expect(r.statusCode).toBe(429);
    expect(r.headers["retry-after"]).toBe("60");
    expect(creditGasTopUp).toHaveBeenCalledTimes(10);
    expect((await post(app, { txHash: HASH }, "session-ok")).statusCode).toBe(201); // other credential unaffected
    t = 61_000;
    expect((await post(app, { txHash: HASH })).statusCode).toBe(201);
  });
});
