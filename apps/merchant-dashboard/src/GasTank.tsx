import { useCallback, useEffect, useState } from "react";
import { formatWbt } from "./lib/csv";
import {
  FAUCET_URL, GasError, TX_HASH, creditWithRetry, explorerTxUrl, fetchGasAccount, parseWbtToWei, sendWbtFromWallet,
  type GasAccount, type GasTopUp,
} from "./lib/gas";
import { injectedProvider, shortAddress, type Eip1193Provider } from "./lib/wallet-login";

const when = (s: number) => new Date(s * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";
const wbt = (wei: string) => formatWbt(wei, 8);

function History({ topUps }: { topUps: GasTopUp[] }) {
  if (!topUps.length) return <p className="mt-3 text-sm text-stone-600">No top-ups yet.</p>;
  return (
    <div className="md-table-wrap mt-3">
      <table className="w-full text-left text-sm" aria-label="Top-up history">
        <thead className="bg-stone-50 text-xs uppercase text-stone-500">
          <tr><th className="px-3 py-2">Time</th><th className="px-3 py-2">Amount</th><th className="px-3 py-2">Transaction</th></tr>
        </thead>
        <tbody>
          {topUps.map((t) => {
            const url = explorerTxUrl(t.txHash);
            return (
              <tr key={t.txHash} className="border-t border-stone-100" data-testid="topup-row">
                <td className="px-3 py-2 text-stone-600">{when(t.creditedAt)}</td>
                <td className="px-3 py-2 font-medium tabular-nums">{wbt(t.wei)} WBT</td>
                <td className="px-3 py-2 font-mono text-xs">
                  {url ? <a className="text-blue-700 underline" href={url} target="_blank" rel="noopener noreferrer">{t.txHash.slice(0, 10)}…{t.txHash.slice(-6)}</a> : t.txHash.slice(0, 10)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Prepaid gas for the relayer. QuietPay's relayer pays network gas (WBT) for every customer payment and refund; the
 * merchant tops up the tank from their payout wallet. Credits are made server-side, from the chain, never from the browser.
 */
export function GasTank({ merchantUrl, token, provider }: { merchantUrl: string; token?: string; provider?: Eip1193Provider }) {
  const [account, setAccount] = useState<GasAccount>();
  const [loadError, setLoadError] = useState("");
  const [amount, setAmount] = useState("");
  const [hash, setHash] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!token) return;
    try {
      setAccount(await fetchGasAccount({ merchantUrl, token }));
      setLoadError("");
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, [merchantUrl, token]);
  useEffect(() => { void load(); }, [load]);

  async function credit(txHash: string) {
    if (!token) return;
    setStatus(`Waiting for ${account?.minConfirmations ?? "enough"} confirmations…`);
    const result = await creditWithRetry({
      merchantUrl, token, txHash,
      onWaiting: () => setStatus(`Waiting for ${account?.minConfirmations ?? "enough"} confirmations…`),
    });
    setAccount(result.account);
    setStatus(`Added ${wbt(result.topUp.wei)} WBT`);
  }

  async function run(job: () => Promise<void>) {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      await job();
    } catch (e) {
      setStatus("");
      setError(e instanceof GasError ? e.message : "Something went wrong with the top-up.");
    } finally {
      setBusy(false);
    }
  }

  const wei = parseWbtToWei(amount);
  const sendFromWallet = () => run(async () => {
    if (!account) return;
    if (wei === undefined) throw new GasError("Enter an amount in WBT greater than 0 (up to 18 decimals).");
    const txHash = await sendWbtFromWallet({ provider: provider ?? injectedProvider(), account, wei });
    setHash("");
    await credit(txHash);
  });
  const creditPasted = () => run(async () => {
    const h = hash.trim();
    if (!TX_HASH.test(h)) throw new GasError("Paste a full transaction hash: 0x followed by 64 hex characters.");
    await credit(h);
    setHash("");
  });

  const negative = account ? BigInt(account.balanceWei) < 0n : false;
  return (
    <section aria-labelledby="gas-title" className="md-glass mb-6 rounded-lg border border-stone-200 bg-white p-4 sm:p-5" data-testid="gas-tank">
      <h2 id="gas-title" className="font-semibold">Gas tank</h2>
      <p className="mt-1 text-sm text-stone-600">QuietPay's relayer pays the network gas for your customers' payments and refunds; your gas tank prepays it.</p>
      {loadError && <p role="alert" className="mt-3 text-sm text-red-700">{loadError}</p>}
      {!account && !loadError && <p role="status" className="mt-3 text-sm text-stone-600">Loading gas tank…</p>}
      {account && (
        <>
          {account.lowBalance && (
            <p role="alert" data-testid="gas-low" className="mt-3 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              Gas is running low. Add WBT below so customer payments and refunds keep going through.
            </p>
          )}
          <div className="mt-4 flex flex-wrap items-end gap-x-10 gap-y-3">
            <div>
              <div className="text-xs text-stone-600">Gas balance</div>
              <div className={`text-3xl font-semibold tabular-nums ${negative ? "text-red-700" : ""}`} data-testid="gas-balance">{wbt(account.balanceWei)} WBT</div>
              <div className="text-sm text-stone-600" data-testid="gas-left">
                {account.paymentsLeft === null ? "add gas to estimate" : `≈ ${account.paymentsLeft} payments left`}
              </div>
            </div>
            <dl className="flex gap-8 text-sm">
              <div><dt className="text-xs text-stone-600">Credited</dt><dd className="font-medium tabular-nums">{wbt(account.creditedWei)} WBT</dd></div>
              <div><dt className="text-xs text-stone-600">Spent</dt><dd className="font-medium tabular-nums">{wbt(account.spentWei)} WBT</dd></div>
            </dl>
          </div>

          <h3 className="mt-6 text-sm font-semibold">Buy gas</h3>
          <div className="mt-2 grid gap-4 md:grid-cols-3">
            <div className="rounded border border-stone-200 p-3">
              <h4 className="text-sm font-medium">Top up from your wallet (WBT)</h4>
              <label className="mt-2 block text-xs text-stone-600">Amount (WBT)
                <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="1.5" autoComplete="off" disabled={busy}
                  className="mt-1 block w-full rounded border border-stone-300 px-2 py-1 text-sm text-stone-900" />
              </label>
              {amount && wei === undefined && <p className="mt-1 text-xs text-red-700">Enter a number above 0 with at most 18 decimals.</p>}
              <button type="button" onClick={() => void sendFromWallet()} disabled={busy || wei === undefined}
                className="mt-2 rounded bg-stone-900 px-3 py-2 text-sm font-medium text-white hover:bg-stone-700 disabled:opacity-50">Send WBT from MetaMask</button>
              <p className="mt-2 text-xs text-stone-600">Sent to {shortAddress(account.relayer)}. Only top-ups from your payout wallet {shortAddress(account.payout)} are credited.</p>
            </div>

            <div className="rounded border border-stone-200 p-3">
              <h4 className="text-sm font-medium">Already sent WBT? Paste the transaction hash</h4>
              <label className="mt-2 block text-xs text-stone-600">Transaction hash
                <input value={hash} onChange={(e) => setHash(e.target.value)} placeholder="0x…" autoComplete="off" spellCheck={false} disabled={busy}
                  className="mt-1 block w-full rounded border border-stone-300 px-2 py-1 font-mono text-xs text-stone-900" />
              </label>
              <button type="button" onClick={() => void creditPasted()} disabled={busy || !hash.trim()}
                className="mt-2 rounded border border-stone-300 px-3 py-2 text-sm font-medium text-stone-800 hover:bg-stone-50 disabled:opacity-50">Credit</button>
            </div>

            <div className="rounded border border-stone-200 p-3">
              <h4 className="text-sm font-medium">Buy with card</h4>
              <button type="button" disabled className="mt-2 rounded border border-stone-300 px-3 py-2 text-sm font-medium text-stone-500 opacity-60">Buy with card</button>
              <p className="mt-2 text-xs text-stone-600">
                Available on mainnet. On testnet, get free WBT from the{" "}
                <a className="text-blue-700 underline" href={FAUCET_URL} target="_blank" rel="noopener noreferrer">Whitechain faucet</a>.
              </p>
            </div>
          </div>
          {status && <p role="status" className="mt-3 text-sm text-stone-700">{status}</p>}
          {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}

          <h3 className="mt-6 text-sm font-semibold">Top-up history</h3>
          <History topUps={account.topUps} />
        </>
      )}
    </section>
  );
}
