import { describe, expect, it, vi } from "vitest";
import { GasError, WHITECHAIN_CHAIN_ID, creditTopUp, creditWithRetry, explorerTxUrl, fetchGasAccount, parseWbtToWei, sendWbtFromWallet } from "../src/lib/gas";

const HASH = "0x" + "ab".repeat(32);
const PAYOUT = "0xAbCdEf0000000000000000000000000000000001";
const RELAYER = "0x" + "11".repeat(20);
const account = {
  merchantId: "m", relayer: RELAYER, payout: PAYOUT, creditedWei: "0", spentWei: "0", balanceWei: "0", lowBalance: false,
  avgGasPerOrderWei: "0", paymentsLeft: null, minConfirmations: 2, topUps: [],
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("parseWbtToWei", () => {
  it.each([
    ["1", 10n ** 18n], ["1.5", 15n * 10n ** 17n], ["0.000000000000000001", 1n], ["0.1", 10n ** 17n],
    ["123456789.123456789123456789", 123456789123456789123456789n], [" 2 ", 2n * 10n ** 18n], ["1.", undefined as never],
  ])("%s", (input, wei) => expect(parseWbtToWei(input)).toBe(wei));
  it.each(["", "0", "0.0", "-1", "+1", "1e3", "0x10", "1,5", "abc", ".5", "1.0000000000000000001", "1 2", "NaN", "Infinity"])("rejects %j", (input) =>
    expect(parseWbtToWei(input)).toBeUndefined());
  it("is exact where floats are not", () => {
    expect(parseWbtToWei("0.3")).toBe(300000000000000000n);
    expect(parseWbtToWei("9007199254740993")).toBe(9007199254740993n * 10n ** 18n);
  });
});

describe("client", () => {
  it("builds the explorer link only for a real hash", () => {
    expect(explorerTxUrl(HASH)).toBe(`https://explorer.testnet.whitechain.io/tx/${HASH}`);
    expect(explorerTxUrl("javascript:alert(1)")).toBeNull();
  });
  it("reads the account with bearer auth", async () => {
    const f = vi.fn(async (_u: unknown, _i?: RequestInit) => json(account));
    await expect(fetchGasAccount({ merchantUrl: "/api/merchant/", token: "tok", fetch: f as unknown as typeof fetch })).resolves.toEqual(account);
    expect(f.mock.calls[0]![0]).toBe("/api/merchant/gas");
    expect((f.mock.calls[0]![1]!.headers as Record<string, string>).authorization).toBe("Bearer tok");
  });
  it("maps errors", async () => {
    const o = (f: typeof fetch) => ({ merchantUrl: "/m", token: "t", fetch: f });
    await expect(fetchGasAccount(o(vi.fn(async () => json({}, 401))))).rejects.toThrow(/session expired/);
    await expect(fetchGasAccount(o(vi.fn(async () => json({}))))).rejects.toThrow(/malformed/);
    await expect(fetchGasAccount(o(vi.fn(async () => { throw new Error("x"); })))).rejects.toThrow(/not reachable/);
    await expect(fetchGasAccount({ merchantUrl: "/m", token: "" })).rejects.toBeInstanceOf(GasError);
    const e = await creditTopUp({ ...o(vi.fn(async () => json({ error: { code: "topup_wrong_sender", message: "nope" } }, 403))), txHash: HASH }).catch((x) => x);
    expect(e).toMatchObject({ code: "topup_wrong_sender", message: "nope" });
  });
});

function wallet(over: Record<string, unknown> = {}) {
  const calls: { method: string; params?: unknown[] }[] = [];
  const provider = {
    request: vi.fn(async (a: { method: string; params?: unknown[] }) => {
      calls.push(a);
      if (a.method in over) {
        const v = over[a.method];
        if (v instanceof Error || (typeof v === "object" && v && "code" in v)) throw v;
        return v;
      }
      return { eth_requestAccounts: [PAYOUT.toLowerCase()], eth_chainId: "0x1", wallet_switchEthereumChain: null, eth_sendTransaction: HASH }[a.method];
    }),
  };
  return { provider, calls };
}

describe("sendWbtFromWallet", () => {
  it("switches chain and sends the exact value to the relayer", async () => {
    const { provider, calls } = wallet();
    await expect(sendWbtFromWallet({ provider, account: { relayer: RELAYER, payout: PAYOUT }, wei: 15n * 10n ** 17n })).resolves.toBe(HASH);
    expect(calls.map((c) => c.method)).toEqual(["eth_requestAccounts", "eth_chainId", "wallet_switchEthereumChain", "eth_sendTransaction"]);
    expect(calls[2]!.params).toEqual([{ chainId: WHITECHAIN_CHAIN_ID }]);
    expect(calls[3]!.params).toEqual([{ from: PAYOUT.toLowerCase(), to: RELAYER, value: "0x14d1120d7b160000" }]);
  });
  it("skips the switch when already on Whitechain", async () => {
    const { provider, calls } = wallet({ eth_chainId: "0x752" });
    await sendWbtFromWallet({ provider, account: { relayer: RELAYER, payout: PAYOUT }, wei: 1n });
    expect(calls.map((c) => c.method)).not.toContain("wallet_switchEthereumChain");
  });
  it("refuses another wallet before sending anything", async () => {
    const { provider, calls } = wallet({ eth_requestAccounts: ["0x" + "99".repeat(20)] });
    await expect(sendWbtFromWallet({ provider, account: { relayer: RELAYER, payout: PAYOUT }, wei: 1n })).rejects.toThrow(
      `Switch MetaMask to your payout wallet ${PAYOUT}: only top-ups from it are credited`,
    );
    expect(calls.map((c) => c.method)).toEqual(["eth_requestAccounts"]);
  });
  it("reports rejection, no wallet and failures", async () => {
    const acct = { relayer: RELAYER, payout: PAYOUT };
    await expect(sendWbtFromWallet({ provider: wallet({ eth_sendTransaction: { code: 4001 } }).provider, account: acct, wei: 1n })).rejects.toThrow("Cancelled in MetaMask");
    await expect(sendWbtFromWallet({ provider: wallet({ eth_requestAccounts: { code: 4001 } }).provider, account: acct, wei: 1n })).rejects.toThrow("Cancelled in MetaMask");
    await expect(sendWbtFromWallet({ account: acct, wei: 1n })).rejects.toThrow(/No wallet found/);
    await expect(sendWbtFromWallet({ provider: wallet({ eth_sendTransaction: "nope" }).provider, account: acct, wei: 1n })).rejects.toThrow(/transaction hash/);
    await expect(sendWbtFromWallet({ provider: wallet({ eth_sendTransaction: new Error("boom") }).provider, account: acct, wei: 1n })).rejects.toThrow(/could not send/);
  });
});

describe("creditWithRetry", () => {
  const err = (code: string, status: number) => json({ error: { code, message: code } }, status);
  it("retries unconfirmed and not-found answers every 4s, then succeeds", async () => {
    vi.useFakeTimers();
    try {
      const answers = [err("topup_not_found", 404), err("topup_unconfirmed", 409), json({ topUp: { txHash: HASH }, account }, 201)];
      const f = vi.fn(async () => answers.shift()!);
      const waiting = vi.fn();
      const p = creditWithRetry({ merchantUrl: "/m", token: "t", txHash: HASH, fetch: f as unknown as typeof fetch, onWaiting: waiting });
      await vi.advanceTimersByTimeAsync(0);
      expect(f).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(3999);
      expect(f).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(f).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(4000);
      await expect(p).resolves.toMatchObject({ account });
      expect(f).toHaveBeenCalledTimes(3);
      expect(waiting).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
  it("gives up after 2 minutes", async () => {
    vi.useFakeTimers();
    try {
      const f = vi.fn(async () => err("topup_unconfirmed", 409));
      const p = creditWithRetry({ merchantUrl: "/m", token: "t", txHash: HASH, fetch: f as unknown as typeof fetch });
      const done = p.catch((e) => e);
      await vi.advanceTimersByTimeAsync(130_000);
      expect(await done).toMatchObject({ code: "topup_unconfirmed" });
      expect(f.mock.calls.length).toBe(31); // attempts at 0, 4, ... 120s
    } finally {
      vi.useRealTimers();
    }
  });
  it.each([["topup_wrong_sender", 403], ["topup_invalid", 422], ["topup_already_credited", 409]])("does not retry %s", async (code, status) => {
    const f = vi.fn(async () => err(code, status));
    await expect(creditWithRetry({ merchantUrl: "/m", token: "t", txHash: HASH, fetch: f as unknown as typeof fetch, sleep: async () => undefined })).rejects.toMatchObject({ code });
    expect(f).toHaveBeenCalledTimes(1);
  });
});
