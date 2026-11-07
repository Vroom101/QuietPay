import { describe, expect, it } from "vitest";
import { createQuietPay, creditGasTopUp, getGasAccount, QuietpayApiError, type GasAccount } from "../src/index.js";

const hash = "0x" + "ab".repeat(32);
const account: GasAccount = {
  merchantId: "0x" + "01".repeat(32), relayer: "0x" + "44".repeat(20), payout: "0x" + "22".repeat(20),
  creditedWei: "100", spentWei: "112", balanceWei: "-12", lowBalance: true, avgGasPerOrderWei: "56", paymentsLeft: 0,
  minConfirmations: 2, topUps: [{ txHash: hash, from: "0x" + "22".repeat(20), wei: "100", block: 7, creditedAt: 1_800_000_000 }],
};

function stub(status: number, body: unknown) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status });
  };
  return { calls, fetcher };
}

describe("gas tank SDK", () => {
  it("getGasAccount GETs /v1/merchant/gas with the bearer key and validates the shape", async () => {
    const s = stub(200, account);
    const a = await getGasAccount({ baseUrl: "https://relayer.test/", apiKey: "k", fetch: s.fetcher });
    expect(a).toEqual(account);
    expect(s.calls[0]!.url).toBe("https://relayer.test/v1/merchant/gas");
    expect((s.calls[0]!.init?.headers as Record<string, string>).authorization).toBe("Bearer k");
  });

  it("creditGasTopUp POSTs the hash and returns topUp + account", async () => {
    const s = stub(201, { topUp: account.topUps[0], account });
    const r = await creditGasTopUp({ baseUrl: "https://relayer.test", apiKey: "k", txHash: hash, fetch: s.fetcher });
    expect(r.topUp.txHash).toBe(hash);
    expect(r.account.balanceWei).toBe("-12");
    expect(s.calls[0]!.url).toBe("https://relayer.test/v1/merchant/gas/topups");
    expect(s.calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(String(s.calls[0]!.init?.body))).toEqual({ txHash: hash });
    expect((s.calls[0]!.init?.headers as Record<string, string>)["content-type"]).toMatch(/json/);
  });

  it("rejects a malformed hash locally without calling the network", async () => {
    const s = stub(201, {});
    await expect(creditGasTopUp({ baseUrl: "https://relayer.test", apiKey: "k", txHash: "0x12", fetch: s.fetcher })).rejects.toThrow();
    expect(s.calls).toHaveLength(0);
  });

  it.each([["topup_not_found", 404], ["topup_unconfirmed", 409], ["topup_invalid", 422], ["topup_wrong_sender", 403], ["topup_already_credited", 409]])(
    "surfaces %s as QuietpayApiError",
    async (code, status) => {
      const s = stub(status, { error: { code, message: "x" } });
      const err = await creditGasTopUp({ baseUrl: "https://relayer.test", apiKey: "k", txHash: hash, fetch: s.fetcher }).catch((e) => e);
      expect(err).toBeInstanceOf(QuietpayApiError);
      expect(err).toMatchObject({ status, code });
    },
  );

  it("throws on a response that breaks the contract", async () => {
    const s = stub(200, { ...account, balanceWei: 5 });
    await expect(getGasAccount({ baseUrl: "https://relayer.test", apiKey: "k", fetch: s.fetcher })).rejects.toThrow();
  });

  it("client.gas.account / creditTopUp use the configured baseUrl, key and fetch", async () => {
    const s = stub(200, account);
    const qp = createQuietPay({ baseUrl: "https://relayer.test", apiKey: "client-key", merchantId: account.merchantId, fetch: s.fetcher } as never);
    expect(await qp.gas.account()).toEqual(account);
    const s2 = stub(201, { topUp: account.topUps[0], account });
    const qp2 = createQuietPay({ baseUrl: "https://relayer.test", apiKey: "client-key", merchantId: account.merchantId, fetch: s2.fetcher } as never);
    expect((await qp2.gas.creditTopUp(hash)).account.paymentsLeft).toBe(0);
    expect((s.calls[0]!.init?.headers as Record<string, string>).authorization).toBe("Bearer client-key");
    expect(s2.calls[0]!.url).toBe("https://relayer.test/v1/merchant/gas/topups");
  });
});
