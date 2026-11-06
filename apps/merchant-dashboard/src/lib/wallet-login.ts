/** Sign in to the merchant server with an injected (MetaMask-style) wallet. Provider and fetch are injectable. */
export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

export interface WalletSession {
  token: string;
  address: string;
  expiresAt: number;
}

export class WalletLoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WalletLoginError";
  }
}

const rejected = (e: unknown) => typeof e === "object" && e !== null && (e as { code?: unknown }).code === 4001;
const trim = (url: string) => url.replace(/\/+$/, "");

/** The browser's injected wallet, if any. */
export function injectedProvider(): Eip1193Provider | undefined {
  return (globalThis as { ethereum?: Eip1193Provider }).ethereum;
}

export function shortAddress(address: string): string {
  return address.length > 10 ? `${address.slice(0, 5)}…${address.slice(-4)}` : address;
}

async function postJson(fetchFn: typeof fetch, url: string, body: unknown): Promise<Response> {
  try {
    return await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    throw new WalletLoginError("Could not reach the merchant server.");
  }
}

export async function signInWithWallet(opts: {
  merchantUrl: string;
  provider?: Eip1193Provider;
  fetch?: typeof fetch;
}): Promise<WalletSession> {
  const provider = opts.provider;
  if (!provider) throw new WalletLoginError("No wallet found. Install MetaMask, then try again.");
  const fetchFn = opts.fetch ?? fetch;
  const base = trim(opts.merchantUrl);

  let address: string;
  try {
    const accounts = await provider.request({ method: "eth_requestAccounts" });
    const first = Array.isArray(accounts) ? accounts[0] : undefined;
    if (typeof first !== "string") throw new WalletLoginError("The wallet did not share an account.");
    address = first;
  } catch (e) {
    if (e instanceof WalletLoginError) throw e;
    throw new WalletLoginError(rejected(e) ? "Sign-in was cancelled in the wallet." : "Could not connect to the wallet.");
  }

  const challengeRes = await postJson(fetchFn, `${base}/auth/challenge`, { address });
  const challenge = (await challengeRes.json().catch(() => undefined)) as { nonce?: unknown; message?: unknown } | undefined;
  if (!challengeRes.ok || typeof challenge?.nonce !== "string" || typeof challenge.message !== "string")
    throw new WalletLoginError("The merchant server did not accept the sign-in request.");

  let signature: unknown;
  try {
    signature = await provider.request({ method: "personal_sign", params: [challenge.message, address] });
  } catch (e) {
    throw new WalletLoginError(rejected(e) ? "Sign-in was cancelled in the wallet." : "The wallet could not sign the message.");
  }
  if (typeof signature !== "string") throw new WalletLoginError("The wallet could not sign the message.");

  const verifyRes = await postJson(fetchFn, `${base}/auth/verify`, { nonce: challenge.nonce, signature });
  const session = (await verifyRes.json().catch(() => undefined)) as Partial<WalletSession> | undefined;
  // The server answers every failure the same way (no way to probe which wallets are allowed). The wallet shown here is
  // the user's OWN connected account, so naming it leaks nothing and tells them exactly what to add.
  if (verifyRes.status === 401)
    throw new WalletLoginError(
      `This wallet (${address}) was not accepted for the merchant dashboard (sign-in failed). If it should have access, ask the store owner to add this address to QUIETPAY_MERCHANT_WALLETS. Otherwise switch to the merchant account in your wallet.`,
    );
  if (!verifyRes.ok || typeof session?.token !== "string" || typeof session.address !== "string" || typeof session.expiresAt !== "number")
    throw new WalletLoginError("The merchant server returned an unexpected answer.");
  return { token: session.token, address: session.address, expiresAt: session.expiresAt };
}

/** Best effort: ends the server session. Never throws. */
export async function signOut(opts: { merchantUrl: string; token: string; fetch?: typeof fetch }): Promise<void> {
  try {
    await (opts.fetch ?? fetch)(`${trim(opts.merchantUrl)}/auth/logout`, {
      method: "POST",
      headers: { authorization: `Bearer ${opts.token}` },
    });
  } catch {
    /* the session also expires on its own */
  }
}
