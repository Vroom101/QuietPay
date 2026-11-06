import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { recoverTypedDataAddress } from "viem";
import { recoverCheckoutSigner } from "@quietpay/shared";
import { FIXTURE_ROUTER, orderCreated } from "@quietpay/shared/fixtures";
import { signCheckout, WidgetError } from "../src/client.js";
import { WHITECHAIN_SEPOLIA, connectMetaMask, metamaskAvailable, readUsdtBalance, requireBalance, type Eip1193 } from "../src/wallet.js";

/** A fake MetaMask: a real key signs, and every request is recorded so tests can assert what the wallet was asked. */
function fakeWallet(opts: { key?: `0x${string}`; chain?: number; knownChains?: number[]; signWith?: `0x${string}`; failOn?: Record<string, number | Error> } = {}) {
  const key = opts.key ?? generatePrivateKey();
  const acct = privateKeyToAccount(key);
  const calls: { method: string; params?: unknown[] }[] = [];
  let chain = opts.chain ?? 1;
  const known = new Set(opts.knownChains ?? [1]);
  let accounts = [acct.address.toLowerCase()];
  const provider: Eip1193 = {
    async request({ method, params }) {
      calls.push({ method, params });
      const fail = opts.failOn?.[method];
      if (fail !== undefined) throw fail instanceof Error ? fail : Object.assign(new Error(`wallet error ${fail}`), { code: fail });
      switch (method) {
        case "eth_requestAccounts":
        case "eth_accounts":
          return accounts;
        case "eth_chainId":
          return "0x" + chain.toString(16);
        case "wallet_switchEthereumChain": {
          const id = Number(BigInt((params![0] as { chainId: string }).chainId));
          if (!known.has(id)) throw Object.assign(new Error("Unrecognized chain ID"), { code: 4902 });
          chain = id;
          return null;
        }
        case "wallet_addEthereumChain": {
          known.add(Number(BigInt((params![0] as { chainId: string }).chainId)));
          return null;
        }
        case "eth_signTypedData_v4": {
          const typed = JSON.parse(params![1] as string);
          const signer = privateKeyToAccount(opts.signWith ?? key);
          // viem wants the EIP712Domain type removed and bigint-capable values; strings are accepted for uint256.
          const { EIP712Domain: _d, ...types } = typed.types;
          return signer.signTypedData({ domain: typed.domain, types, primaryType: typed.primaryType, message: typed.message });
        }
        default:
          throw new Error(`unexpected method ${method}`);
      }
    },
  };
  return { provider, acct, calls, setAccounts: (a: string[]) => (accounts = a), chainNow: () => chain };
}

describe("Feature: pay with a MetaMask account (gasless: the relayer still pays the gas)", () => {
  it("Scenario: no wallet installed", async () => {
    expect(metamaskAvailable(undefined)).toBe(false);
    await expect(connectMetaMask({ provider: undefined })).rejects.toMatchObject({ code: "wallet_unavailable" });
  });

  it("Scenario: connect, switch to Whitechain Sepolia, and sign", async () => {
    // Given a wallet on another chain that already knows chain 1874
    const w = fakeWallet({ knownChains: [1, 1874] });
    // When the payer connects
    const signer = await connectMetaMask({ provider: w.provider });
    // Then the first account is used (checksummed) and the wallet is switched to 1874
    expect(signer.address).toBe(w.acct.address);
    expect(w.chainNow()).toBe(1874);
    expect(w.calls.map((c) => c.method)).toEqual(expect.arrayContaining(["eth_requestAccounts", "wallet_switchEthereumChain"]));
  });

  it("Scenario: the wallet does not know the chain, so it is added once and then switched", async () => {
    const w = fakeWallet({ knownChains: [1] });
    await connectMetaMask({ provider: w.provider });
    const add = w.calls.find((c) => c.method === "wallet_addEthereumChain");
    expect(add).toBeDefined();
    const added = add!.params![0] as { chainId: string; nativeCurrency: { symbol: string }; rpcUrls: string[] };
    expect(added.chainId).toBe("0x752");
    expect(added.nativeCurrency.symbol).toBe("WBT");
    expect(added.rpcUrls.every((u) => u.startsWith("https://"))).toBe(true);
    expect(w.chainNow()).toBe(1874);
  });

  it("Scenario: the user rejects the connection", async () => {
    const w = fakeWallet({ failOn: { eth_requestAccounts: 4001 } });
    await expect(connectMetaMask({ provider: w.provider })).rejects.toMatchObject({ code: "wallet_rejected" });
  });

  it("Scenario: the user rejects the chain switch", async () => {
    const w = fakeWallet({ knownChains: [1, 1874], failOn: { wallet_switchEthereumChain: 4001 } });
    await expect(connectMetaMask({ provider: w.provider })).rejects.toMatchObject({ code: "wallet_rejected" });
  });

  it("Scenario: a signed checkout recovers the MetaMask address and is what the relayer verifies", async () => {
    const w = fakeWallet({ knownChains: [1, 1874] });
    const signer = await connectMetaMask({ provider: w.provider });
    const req = await signCheckout(signer, orderCreated, 1_800_000_100, { expected: { router: FIXTURE_ROUTER } });
    const c = orderCreated.checkout;
    const recovered = await recoverCheckoutSigner(
      { from: signer.address, router: c.router as `0x${string}`, value: BigInt(c.value), nonce: c.nonce as `0x${string}`, validAfter: BigInt(req.validAfter), validBefore: BigInt(req.validBefore), chainId: c.chainId, token: c.token as `0x${string}`, domainName: c.domain.name, domainVersion: c.domain.version },
      req.signature as `0x${string}`,
    );
    expect(recovered).toBe(w.acct.address);
    expect(req.payer).toBe(w.acct.address);
  });

  it("the typed data sent to the wallet is complete: EIP712Domain type, numeric chain id, stringified numbers", async () => {
    const w = fakeWallet({ knownChains: [1, 1874] });
    const signer = await connectMetaMask({ provider: w.provider });
    await signCheckout(signer, orderCreated, 1_800_000_100, { expected: { router: FIXTURE_ROUTER } });
    const sign = w.calls.find((c) => c.method === "eth_signTypedData_v4")!;
    expect(sign.params![0]).toBe(w.acct.address.toLowerCase() === (sign.params![0] as string).toLowerCase() ? sign.params![0] : "mismatch");
    const typed = JSON.parse(sign.params![1] as string);
    expect(typed.primaryType).toBe("ReceiveWithAuthorization");
    expect(typed.types.EIP712Domain.map((f: { name: string }) => f.name)).toEqual(["name", "version", "chainId", "verifyingContract"]);
    expect(typed.domain.chainId).toBe(1874);
    for (const k of ["value", "validAfter", "validBefore"]) expect(typeof typed.message[k]).toBe("string");
  });
});

describe("Attack: a wallet that lies or changes under us never gets a payment signed", () => {
  it("refuses a signature that does not recover to the connected account", async () => {
    // The wallet reports account A but signs with key B.
    const w = fakeWallet({ knownChains: [1, 1874], signWith: generatePrivateKey() });
    const signer = await connectMetaMask({ provider: w.provider });
    await expect(signCheckout(signer, orderCreated, 1_800_000_100, { expected: { router: FIXTURE_ROUTER } })).rejects.toMatchObject({ code: "wallet_signature_mismatch" });
  });

  it("refuses to sign when the selected account changed after connecting", async () => {
    const w = fakeWallet({ knownChains: [1, 1874] });
    const signer = await connectMetaMask({ provider: w.provider });
    w.setAccounts([privateKeyToAccount(generatePrivateKey()).address.toLowerCase()]);
    await expect(signCheckout(signer, orderCreated, 1_800_000_100, { expected: { router: FIXTURE_ROUTER } })).rejects.toMatchObject({ code: "wallet_account_changed" });
    expect(w.calls.some((c) => c.method === "eth_signTypedData_v4")).toBe(false);
  });

  it("refuses to sign when the wallet is not on chain 1874 any more", async () => {
    const w = fakeWallet({ knownChains: [1, 1874] });
    const signer = await connectMetaMask({ provider: w.provider });
    await w.provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x1" }] });
    await expect(signCheckout(signer, orderCreated, 1_800_000_100, { expected: { router: FIXTURE_ROUTER } })).rejects.toMatchObject({ code: "wallet_wrong_chain" });
  });

  it("the order is still verified BEFORE the wallet is asked: a hostile router never reaches MetaMask", async () => {
    const w = fakeWallet({ knownChains: [1, 1874] });
    const signer = await connectMetaMask({ provider: w.provider });
    await expect(signCheckout(signer, orderCreated, 1_800_000_100, { expected: { router: "0x" + "99".repeat(20) as `0x${string}` } })).rejects.toBeInstanceOf(WidgetError);
    expect(w.calls.some((c) => c.method === "eth_signTypedData_v4")).toBe(false);
  });

  it("a user rejection at the signing prompt is reported plainly and nothing is sent", async () => {
    const w = fakeWallet({ knownChains: [1, 1874], failOn: { eth_signTypedData_v4: 4001 } });
    const signer = await connectMetaMask({ provider: w.provider });
    await expect(signCheckout(signer, orderCreated, 1_800_000_100, { expected: { router: FIXTURE_ROUTER } })).rejects.toMatchObject({ code: "wallet_rejected" });
  });

  it("rejects a provider that returns something that is not an address", async () => {
    const bad: Eip1193 = { request: async ({ method }) => (method === "eth_requestAccounts" ? ["not-an-address"] : null) };
    await expect(connectMetaMask({ provider: bad })).rejects.toMatchObject({ code: "wallet_unavailable" });
  });

  it("rejects an empty account list (locked wallet)", async () => {
    const empty: Eip1193 = { request: async ({ method }) => (method === "eth_requestAccounts" ? [] : null) };
    await expect(connectMetaMask({ provider: empty })).rejects.toMatchObject({ code: "wallet_unavailable" });
  });

  it("[sanity] recoverTypedDataAddress is what the check relies on", async () => {
    const k = privateKeyToAccount(generatePrivateKey());
    const td = { domain: { name: "x", version: "1", chainId: 1874, verifyingContract: k.address }, types: { M: [{ name: "a", type: "uint256" }] }, primaryType: "M" as const, message: { a: 1n } };
    expect(await recoverTypedDataAddress({ ...td, signature: await k.signTypedData(td) })).toBe(k.address);
  });
});

describe("Feature: tell the payer about a short balance before asking them to sign", () => {
  // balanceOf(address) selector 0x70a08231; the fake answers eth_call with the configured amount as a 32-byte word.
  const withBalance = (base: bigint) => {
    const w = fakeWallet({ knownChains: [1, 1874] });
    const inner = w.provider.request.bind(w.provider);
    w.provider.request = async (args) => {
      if (args.method === "eth_call") {
        w.calls.push(args);
        return "0x" + base.toString(16).padStart(64, "0");
      }
      return inner(args);
    };
    return w;
  };
  const token = "0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7" as const;

  it("Scenario: enough USDT passes and returns the balance", async () => {
    const w = withBalance(50_000_000n);
    const signer = await connectMetaMask({ provider: w.provider });
    expect(await readUsdtBalance(w.provider, token, signer.address)).toBe(50_000_000n);
    await expect(requireBalance(w.provider, token, signer.address, 17_000_000n)).resolves.toBeUndefined();
  });

  it("Scenario: too little USDT names both amounts and nothing is signed", async () => {
    const w = withBalance(2_500_000n);
    const signer = await connectMetaMask({ provider: w.provider });
    await expect(requireBalance(w.provider, token, signer.address, 17_000_000n)).rejects.toMatchObject({
      code: "wallet_insufficient_balance",
      message: expect.stringMatching(/2\.5.*17/s),
    });
    expect(w.calls.some((c) => c.method === "eth_signTypedData_v4")).toBe(false);
  });

  it("the balance call is a plain read: balanceOf of the connected account on the token", async () => {
    const w = withBalance(1n);
    const signer = await connectMetaMask({ provider: w.provider });
    await readUsdtBalance(w.provider, token, signer.address);
    const call = w.calls.find((c) => c.method === "eth_call")!;
    const tx = call.params![0] as { to: string; data: string };
    expect(tx.to.toLowerCase()).toBe(token.toLowerCase());
    expect(tx.data.startsWith("0x70a08231")).toBe(true);
    expect(tx.data.toLowerCase()).toContain(signer.address.slice(2).toLowerCase());
  });

  it("an unreadable balance never blocks a payment (the relayer simulation is the real check)", async () => {
    const w = fakeWallet({ knownChains: [1, 1874] });
    const signer = await connectMetaMask({ provider: w.provider });
    // the fake throws on eth_call (unexpected method): readUsdtBalance reports undefined, requireBalance passes
    expect(await readUsdtBalance(w.provider, token, signer.address)).toBeUndefined();
    await expect(requireBalance(w.provider, token, signer.address, 17_000_000n)).resolves.toBeUndefined();
  });
});
