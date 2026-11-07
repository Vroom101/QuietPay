/**
 * Pay with a browser wallet (MetaMask or any EIP-1193 provider) instead of the built-in demo key.
 *
 * The payer signs the same single ReceiveWithAuthorization as with the demo key (eth_signTypedData_v4, no gas, no
 * transaction); the relayer submits it. The order is verified BEFORE the wallet is ever asked to sign (signCheckout does
 * that), and this module adds three wallet-specific checks: the selected account has not changed, the wallet is on
 * chain 1874, and the returned signature really recovers to the connected account.
 */
import { getAddress, isAddress, recoverTypedDataAddress, type Address, type Hex } from "viem";
import { WidgetError } from "./client.js";

/** Minimal EIP-1193 provider (window.ethereum). */
export interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

/** What signCheckout needs from a signer. A viem PrivateKeyAccount satisfies this too. */
export interface CheckoutSigner {
  address: Address;
  signTypedData(td: {
    domain: Record<string, unknown>;
    types: Record<string, readonly { name: string; type: string }[]>;
    primaryType: string;
    message: Record<string, unknown>;
  }): Promise<Hex>;
}

export const WHITECHAIN_SEPOLIA = {
  chainId: 1874,
  chainName: "Whitechain Sepolia",
  rpcUrls: ["https://rpc.testnet.whitechain.io"],
  nativeCurrency: { name: "WBT", symbol: "WBT", decimals: 18 },
  blockExplorerUrls: ["https://explorer.testnet.whitechain.io"],
} as const;

const hex = (n: number) => "0x" + n.toString(16);
const errCode = (e: unknown) => (e as { code?: number } | undefined)?.code;

/** The injected provider, if any. */
export function injectedProvider(): Eip1193 | undefined {
  return (globalThis as { ethereum?: Eip1193 }).ethereum;
}

export function metamaskAvailable(provider: Eip1193 | undefined = injectedProvider()): boolean {
  return !!provider && typeof provider.request === "function";
}

function wrap(e: unknown, what: string): never {
  if (e instanceof WidgetError) throw e;
  if (errCode(e) === 4001) throw new WidgetError("wallet_rejected", `${what} was cancelled in your wallet`);
  throw new WidgetError("wallet_unavailable", `Your wallet could not ${what}`);
}

async function ensureChain(provider: Eip1193, chain: typeof WHITECHAIN_SEPOLIA): Promise<void> {
  const params = [{ chainId: hex(chain.chainId) }];
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params });
  } catch (e) {
    if (errCode(e) !== 4902) wrap(e, "switch network");
    try {
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [{ chainId: hex(chain.chainId), chainName: chain.chainName, rpcUrls: chain.rpcUrls, nativeCurrency: chain.nativeCurrency, blockExplorerUrls: chain.blockExplorerUrls }],
      });
      await provider.request({ method: "wallet_switchEthereumChain", params });
    } catch (e2) {
      wrap(e2, "add the Whitechain network");
    }
  }
}

/** eth_signTypedData_v4 wants JSON: an explicit EIP712Domain type, a numeric chainId and numbers as decimal strings. */
function toV4Json(td: Parameters<CheckoutSigner["signTypedData"]>[0]): string {
  const d = td.domain as { name?: string; version?: string; chainId?: number | bigint; verifyingContract?: string };
  const domainTypes = [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ];
  return JSON.stringify(
    { types: { EIP712Domain: domainTypes, ...td.types }, domain: { ...d, chainId: Number(d.chainId) }, primaryType: td.primaryType, message: td.message },
    (_k, v) => (typeof v === "bigint" ? v.toString() : v),
  );
}

/**
 * Connects to the wallet, moves it to Whitechain Sepolia (adding the network when the wallet does not know it) and
 * returns a signer for the first selected account.
 */
export async function connectMetaMask(opts: { provider?: Eip1193 | undefined; chain?: typeof WHITECHAIN_SEPOLIA } = {}): Promise<CheckoutSigner> {
  const provider = "provider" in opts ? opts.provider : injectedProvider();
  if (!metamaskAvailable(provider)) throw new WidgetError("wallet_unavailable", "No browser wallet was found. Install MetaMask to pay with it.");
  const p = provider as Eip1193;
  const chain = opts.chain ?? WHITECHAIN_SEPOLIA;

  let accounts: unknown;
  try {
    accounts = await p.request({ method: "eth_requestAccounts" });
  } catch (e) {
    wrap(e, "connect");
  }
  const first = Array.isArray(accounts) ? accounts[0] : undefined;
  if (typeof first !== "string" || !isAddress(first, { strict: false })) {
    throw new WidgetError("wallet_unavailable", "Your wallet did not share an account. Unlock it and try again.");
  }
  const address = getAddress(first);
  await ensureChain(p, chain);

  return {
    address,
    async signTypedData(td) {
      // 1. The account the payer sees selected must still be the one this payment is for.
      let current: unknown;
      let chainId: unknown;
      try {
        current = await p.request({ method: "eth_accounts" });
        chainId = await p.request({ method: "eth_chainId" });
      } catch (e) {
        wrap(e, "read the selected account");
      }
      const sel = Array.isArray(current) ? current[0] : undefined;
      if (typeof sel !== "string" || sel.toLowerCase() !== address.toLowerCase()) {
        throw new WidgetError("wallet_account_changed", "The selected wallet account changed. Reconnect and try again.");
      }
      // 2. Signing for a typed-data domain on another chain is refused by the wallet; check up front for a clear message.
      if (typeof chainId !== "string" || Number(BigInt(chainId)) !== chain.chainId) {
        throw new WidgetError("wallet_wrong_chain", "Switch your wallet to Whitechain Sepolia and try again.");
      }
      // 3. Ask for the signature.
      let signature: unknown;
      try {
        signature = await p.request({ method: "eth_signTypedData_v4", params: [address, toV4Json(td)] });
      } catch (e) {
        wrap(e, "sign the payment");
      }
      if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
        throw new WidgetError("wallet_signature_mismatch", "Your wallet returned an unusable signature.");
      }
      // 4. Never trust the provider: the signature must recover to the connected account over exactly this data.
      const recovered = await recoverTypedDataAddress({
        domain: td.domain,
        types: td.types,
        primaryType: td.primaryType,
        message: td.message,
        signature: signature as Hex,
      } as unknown as Parameters<typeof recoverTypedDataAddress>[0]).catch(() => undefined);
      if (!recovered || recovered.toLowerCase() !== address.toLowerCase()) {
        throw new WidgetError("wallet_signature_mismatch", "The wallet signature did not match your account, so nothing was sent.");
      }
      return signature as Hex;
    },
  };
}

const USDT_DECIMALS = 6n;
const fmt = (base: bigint) => {
  const whole = base / 10n ** USDT_DECIMALS;
  const frac = (base % 10n ** USDT_DECIMALS).toString().padStart(Number(USDT_DECIMALS), "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
};

/** The wallet's balance of `token` (base units), or undefined when it cannot be read (never throws). */
export async function readUsdtBalance(provider: Eip1193, token: string, owner: string): Promise<bigint | undefined> {
  try {
    const data = "0x70a08231" + owner.toLowerCase().replace(/^0x/, "").padStart(64, "0"); // balanceOf(address)
    const out = await provider.request({ method: "eth_call", params: [{ to: token, data }, "latest"] });
    if (typeof out !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(out)) return undefined;
    return BigInt(out);
  } catch {
    return undefined;
  }
}

/**
 * Refuses, with exact numbers, when the wallet clearly holds less than the payment. An unreadable balance passes: the
 * relayer simulates the payment before sending, so this is guidance, not the safety check.
 */
export async function requireBalance(provider: Eip1193, token: string, owner: string, needed: bigint): Promise<void> {
  const have = await readUsdtBalance(provider, token, owner);
  if (have !== undefined && have < needed) {
    throw new WidgetError("wallet_insufficient_balance", `Your wallet has ${fmt(have)} USDT but this payment needs ${fmt(needed)} USDT. Add test USDT to ${owner} and try again.`);
  }
}
