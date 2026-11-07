/** Gas tank client: reads the prepaid gas account and credits WBT top-ups through the store server. */
import type { Eip1193Provider } from "./wallet-login";
import { safeHttpUrl } from "./view";

export interface GasTopUp { txHash: string; from: string; wei: string; block: number; creditedAt: number }
export interface GasAccount {
  merchantId: string; relayer: string; payout: string; creditedWei: string; spentWei: string; balanceWei: string;
  lowBalance: boolean; avgGasPerOrderWei: string; paymentsLeft: number | null; minConfirmations: number; topUps: GasTopUp[];
}

export class GasError extends Error {
  constructor(message: string, readonly code = "gas_error") {
    super(message);
    this.name = "GasError";
  }
}

export const WHITECHAIN_CHAIN_ID = "0x752";
export const EXPLORER_TX = "https://explorer.testnet.whitechain.io/tx/";
export const FAUCET_URL = "https://faucet.testnet.whitechain.io";
export const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const WEI = 10n ** 18n;

export const explorerTxUrl = (hash: string) => (TX_HASH.test(hash) ? safeHttpUrl(EXPLORER_TX + hash) : null);

/** Exact decimal WBT -> wei. Returns undefined for anything that is not a positive decimal with at most 18 decimals. */
export function parseWbtToWei(input: string): bigint | undefined {
  const m = /^(\d+)(?:\.(\d{1,18}))?$/.exec(input.trim());
  if (!m) return undefined;
  const wei = BigInt(m[1]!) * WEI + BigInt((m[2] ?? "").padEnd(18, "0") || "0");
  return wei > 0n ? wei : undefined;
}

const trim = (url: string) => url.replace(/\/+$/, "");
const isAccount = (v: unknown): v is GasAccount => {
  const a = v as Partial<GasAccount> | null;
  return !!a && typeof a === "object" && typeof a.relayer === "string" && typeof a.payout === "string" && typeof a.balanceWei === "string" &&
    typeof a.creditedWei === "string" && typeof a.spentWei === "string" && Array.isArray(a.topUps);
};

async function call(opts: { merchantUrl: string; token: string; fetch?: typeof fetch }, path: string, init?: RequestInit) {
  if (!opts.token) throw new GasError("Sign in to use the gas tank.", "unauthorized");
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(`${trim(opts.merchantUrl)}${path}`, {
      ...init,
      cache: "no-store",
      headers: { ...(init?.body ? { "content-type": "application/json" } : {}), authorization: `Bearer ${opts.token}` },
    });
  } catch {
    throw new GasError("The merchant server is not reachable.", "unreachable");
  }
  const body = (await res.json().catch(() => undefined)) as { error?: { code?: unknown; message?: unknown } } | undefined;
  if (!res.ok) {
    if (res.status === 401) throw new GasError("Your session expired. Sign in again.", "unauthorized");
    const code = typeof body?.error?.code === "string" ? body.error.code : "gas_error";
    const message = typeof body?.error?.message === "string" ? body.error.message : "The gas tank request failed.";
    throw new GasError(message, code);
  }
  return body;
}

export async function fetchGasAccount(opts: { merchantUrl: string; token: string; fetch?: typeof fetch }): Promise<GasAccount> {
  const body = await call(opts, "/gas");
  if (!isAccount(body)) throw new GasError("The merchant server returned a malformed gas account.", "malformed");
  return body;
}

export async function creditTopUp(opts: { merchantUrl: string; token: string; txHash: string; fetch?: typeof fetch }): Promise<{ topUp: GasTopUp; account: GasAccount }> {
  const body = (await call(opts, "/gas/topups", { method: "POST", body: JSON.stringify({ txHash: opts.txHash }) })) as { topUp?: GasTopUp; account?: unknown } | undefined;
  if (!body?.topUp || !isAccount(body.account)) throw new GasError("The merchant server returned a malformed top-up.", "malformed");
  return { topUp: body.topUp, account: body.account };
}

const RETRYABLE = new Set(["topup_unconfirmed", "topup_not_found"]);
const sleepReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Credits a top-up, retrying while the chain has not shown or confirmed the transaction yet (every 4s, up to 2 min). */
export async function creditWithRetry(opts: {
  merchantUrl: string; token: string; txHash: string; fetch?: typeof fetch;
  intervalMs?: number; timeoutMs?: number; onWaiting?: () => void; sleep?: (ms: number) => Promise<void>;
}): Promise<{ topUp: GasTopUp; account: GasAccount }> {
  const interval = opts.intervalMs ?? 4000;
  const timeout = opts.timeoutMs ?? 120_000;
  const sleep = opts.sleep ?? sleepReal;
  const started = Date.now();
  for (;;) {
    try {
      return await creditTopUp(opts);
    } catch (e) {
      if (!(e instanceof GasError) || !RETRYABLE.has(e.code)) throw e;
      if (Date.now() - started + interval > timeout)
        throw new GasError("The transaction is still not confirmed. If you sent it, paste its hash below in a minute to credit it.", e.code);
      opts.onWaiting?.();
      await sleep(interval);
    }
  }
}

const rejected = (e: unknown) => typeof e === "object" && e !== null && (e as { code?: unknown }).code === 4001;

/** Sends `wei` of WBT from the merchant's payout wallet to the relayer with the injected wallet. Returns the tx hash. */
export async function sendWbtFromWallet(opts: { provider?: Eip1193Provider; account: Pick<GasAccount, "relayer" | "payout">; wei: bigint }): Promise<string> {
  const { provider, account, wei } = opts;
  if (!provider) throw new GasError("No wallet found. Install MetaMask, then try again.", "no_wallet");
  try {
    const accounts = await provider.request({ method: "eth_requestAccounts" });
    const from = Array.isArray(accounts) ? accounts[0] : undefined;
    if (typeof from !== "string") throw new GasError("The wallet did not share an account.", "no_account");
    if (from.toLowerCase() !== account.payout.toLowerCase())
      throw new GasError(`Switch MetaMask to your payout wallet ${account.payout}: only top-ups from it are credited`, "wrong_wallet");
    const chain = await provider.request({ method: "eth_chainId" }).catch(() => undefined);
    if (typeof chain !== "string" || chain.toLowerCase() !== WHITECHAIN_CHAIN_ID)
      await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: WHITECHAIN_CHAIN_ID }] });
    const hash = await provider.request({ method: "eth_sendTransaction", params: [{ from, to: account.relayer, value: "0x" + wei.toString(16) }] });
    if (typeof hash !== "string" || !TX_HASH.test(hash)) throw new GasError("The wallet did not return a transaction hash.", "no_hash");
    return hash;
  } catch (e) {
    if (e instanceof GasError) throw e;
    if (rejected(e)) throw new GasError("Cancelled in MetaMask", "rejected");
    throw new GasError("MetaMask could not send the transaction.", "wallet_error");
  }
}
