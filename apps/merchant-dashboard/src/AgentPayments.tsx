import { useCallback, useEffect, useState } from "react";
import { formatUsdt } from "@quietpay/shared";
import { fetchLedgerExport } from "./lib/ledger-download";
import { agentPayments, totalBase, type AgentPayment } from "./lib/ledger-csv";
import { shortHex } from "./lib/view";

/** Live x402 (AI agent) payments, taken from the on-chain ledger export. */
export function AgentPayments({ merchantUrl, token }: { merchantUrl: string; token?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [payments, setPayments] = useState<AgentPayment[] | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const ledger = await fetchLedgerExport({ merchantUrl, token: token ?? "" });
      setPayments(agentPayments(ledger.csv));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [merchantUrl, token]);

  useEffect(() => {
    setPayments(null);
    if (token) void load();
  }, [token, load]);

  return (
    <section aria-labelledby="agent-title" className="md-glass mb-6 rounded-lg border border-stone-200 bg-white p-4 sm:p-5">
      <h2 id="agent-title" className="font-semibold">Agent payments (x402)</h2>
      <p className="mt-1 text-sm text-stone-600">Paid API calls bought by AI agents over x402. The agent signs, QuietPay&apos;s facilitator pays the gas.</p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => void load()} disabled={busy || !token} className="rounded bg-stone-900 px-3 py-2 text-sm font-medium text-white hover:bg-stone-700 disabled:opacity-50">
          {busy ? "Loading…" : "Load agent payments"}
        </button>
        {!token && <span className="text-sm text-stone-600">Sign in to load.</span>}
      </div>
      {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
      {payments && (
        <>
          <dl className="my-4 flex flex-wrap gap-x-8 gap-y-2 text-sm">
            <div><dt className="text-xs text-stone-600">Agent payments</dt><dd data-testid="agent-count" className="font-medium tabular-nums">{payments.length}</dd></div>
            <div><dt className="text-xs text-stone-600">Received from agents</dt><dd data-testid="agent-total" className="font-medium tabular-nums">{formatUsdt(totalBase(payments))} USDT</dd></div>
          </dl>
          {payments.length === 0 ? (
            <p className="text-sm text-stone-600">No agent payments yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead><tr><th className="px-3 py-2">Time</th><th className="px-3 py-2">Agent</th><th className="px-3 py-2">Amount</th><th className="px-3 py-2">Transaction</th></tr></thead>
                <tbody>
                  {payments.map((p, i) => (
                    <tr key={`${p.txHash}:${i}`} className="border-t border-stone-200">
                      <td className="px-3 py-2">{p.date}</td>
                      <td className="px-3 py-2 font-mono" title={p.payer}>{p.payer.length > 12 ? shortHex(p.payer) : p.payer}</td>
                      <td className="px-3 py-2 tabular-nums">{formatUsdt(p.grossBase)} USDT</td>
                      <td className="px-3 py-2">{p.explorerUrl ? <a href={p.explorerUrl} target="_blank" rel="noreferrer" className="underline">{shortHex(p.txHash)}</a> : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
