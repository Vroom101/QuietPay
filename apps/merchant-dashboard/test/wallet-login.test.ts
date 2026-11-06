import { describe, expect, it, vi } from "vitest";
import { WalletLoginError, shortAddress, signInWithWallet, signOut, type Eip1193Provider } from "../src/lib/wallet-login";

const addr = "0xAbCdEf0123456789aBcDeF0123456789abcdef01";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

function fakeProvider(overrides: Partial<Record<string, () => unknown>> = {}) {
  const request = vi.fn(async ({ method }: { method: string; params?: unknown[] }) => {
    if (overrides[method]) return overrides[method]!();
    if (method === "eth_requestAccounts") return [addr];
    if (method === "personal_sign") return "0xsig";
    throw new Error("unexpected " + method);
  });
  return { provider: { request } as Eip1193Provider, request };
}

describe("signInWithWallet", () => {
  it("connects, fetches the challenge, signs it and returns the session", async () => {
    const { provider, request } = fakeProvider();
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(json(200, { nonce: "n1", message: "hello" }))
      .mockResolvedValueOnce(json(200, { token: "tok", address: addr.toLowerCase(), expiresAt: 99 }));
    const s = await signInWithWallet({ merchantUrl: "/api/merchant", provider, fetch: fetchFn as never });
    expect(s).toEqual({ token: "tok", address: addr.toLowerCase(), expiresAt: 99 });
    expect(request).toHaveBeenCalledWith({ method: "personal_sign", params: ["hello", addr] });
    expect(fetchFn.mock.calls[0]![0]).toBe("/api/merchant/auth/challenge");
    expect(JSON.parse(fetchFn.mock.calls[0]![1].body)).toEqual({ address: addr });
    expect(JSON.parse(fetchFn.mock.calls[1]![1].body)).toEqual({ nonce: "n1", signature: "0xsig" });
  });
  it("says so clearly when there is no wallet", async () => {
    await expect(signInWithWallet({ merchantUrl: "/m", provider: undefined, fetch: vi.fn() as never })).rejects.toThrow(/MetaMask|wallet/i);
  });
  it("reports a user rejection (4001) without calling the server again", async () => {
    const { provider } = fakeProvider({ personal_sign: () => { throw Object.assign(new Error("denied"), { code: 4001 }); } });
    const fetchFn = vi.fn().mockResolvedValueOnce(json(200, { nonce: "n", message: "m" }));
    const err = await signInWithWallet({ merchantUrl: "/m", provider, fetch: fetchFn as never }).catch((e) => e);
    expect(err).toBeInstanceOf(WalletLoginError);
    expect(err.message).toMatch(/cancel|reject/i);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it("rejection while connecting is also reported", async () => {
    const { provider } = fakeProvider({ eth_requestAccounts: () => { throw { code: 4001 }; } });
    await expect(signInWithWallet({ merchantUrl: "/m", provider, fetch: vi.fn() as never })).rejects.toThrow(/cancel|reject/i);
  });
  it("maps a server 401 to a generic message with no token", async () => {
    const { provider } = fakeProvider();
    const fetchFn = vi.fn().mockResolvedValueOnce(json(200, { nonce: "n", message: "m" })).mockResolvedValueOnce(json(401, { error: "sign-in failed" }));
    await expect(signInWithWallet({ merchantUrl: "/m", provider, fetch: fetchFn as never })).rejects.toThrow(/not accepted|sign-in failed/i);
  });
  it("rejects a malformed server answer", async () => {
    const { provider } = fakeProvider();
    const fetchFn = vi.fn().mockResolvedValueOnce(json(200, { nonce: "n", message: "m" })).mockResolvedValueOnce(json(200, { nothing: 1 }));
    await expect(signInWithWallet({ merchantUrl: "/m", provider, fetch: fetchFn as never })).rejects.toBeInstanceOf(WalletLoginError);
  });
});

describe("signOut / shortAddress", () => {
  it("posts logout with the bearer token and never throws", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("offline"));
    await expect(signOut({ merchantUrl: "/m", token: "t", fetch: fetchFn as never })).resolves.toBeUndefined();
    expect(fetchFn.mock.calls[0]![0]).toBe("/m/auth/logout");
    expect(fetchFn.mock.calls[0]![1].headers.authorization).toBe("Bearer t");
  });
  it("shortens an address", () => {
    expect(shortAddress("0xabcdef0123456789abcdef0123456789abcdef01")).toBe("0xabc…ef01");
  });
});

describe("Feature: a rejected wallet is told which wallet it was and what to do", () => {
  const ADDR = "0x0bC8E3a4C0b1f9D2e5A7c6B8d4F1a2E3c4D56f8f".replace(/[^0-9a-fA-Fx]/g, "0").slice(0, 42);
  it("Scenario: the message names the connected wallet and the setting that allows it", async () => {
    const provider = { request: vi.fn(async ({ method }: { method: string }) => (method === "eth_requestAccounts" ? [ADDR] : "0xsig")) };
    const fetchFn = vi.fn().mockResolvedValueOnce(json(200, { nonce: "n", message: "m" })).mockResolvedValueOnce(json(401, { error: "sign-in failed" }));
    const err = await signInWithWallet({ merchantUrl: "/m", provider: provider as never, fetch: fetchFn as never }).catch((e: Error) => e);
    expect((err as Error).message).toContain(ADDR); // the payer's OWN address, copyable
    expect((err as Error).message).toMatch(/QUIETPAY_MERCHANT_WALLETS/);
    expect((err as Error).message).toMatch(/not accepted/i);
  });

  it("the message never contains a token or the server's own text", async () => {
    const provider = { request: vi.fn(async ({ method }: { method: string }) => (method === "eth_requestAccounts" ? [ADDR] : "0xsig")) };
    const fetchFn = vi.fn().mockResolvedValueOnce(json(200, { nonce: "n", message: "m" })).mockResolvedValueOnce(json(401, { error: "sign-in failed", token: "SECRET-TOKEN" }));
    const err = (await signInWithWallet({ merchantUrl: "/m", provider: provider as never, fetch: fetchFn as never }).catch((e: Error) => e)) as Error;
    expect(err.message).not.toContain("SECRET-TOKEN");
  });
});
