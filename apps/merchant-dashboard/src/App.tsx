import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { Order } from "@quietpay/shared";
import { DashboardError, listOrders } from "./lib/api";
import { STATUS_STYLES, shortHex, toRow } from "./lib/view";

const RELAYER_URL = import.meta.env.VITE_RELAYER_URL || "http://localhost:8787";
const USE_FIXTURES = import.meta.env.VITE_USE_FIXTURES === "1";

function loadKey(): string {
  try {
    return sessionStorage.getItem("qp-api-key") ?? "";
  } catch {
    return "";
  }
}

export function App() {
  const [apiKey, setApiKey] = useState(loadKey);
  const [draft, setDraft] = useState("");
  const [orders, setOrders] = useState<Order[]>([]);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      setOrders(await listOrders({ relayerUrl: RELAYER_URL, apiKey, useFixtures: USE_FIXTURES }));
    } catch (e) {
      setOrders([]);
      setError(e instanceof DashboardError ? e.message : "Something went wrong loading orders.");
    } finally {
      setLoading(false);
    }
  }, [apiKey]);

  useEffect(() => {
    if (apiKey || USE_FIXTURES) void load();
  }, [apiKey, load]);

  function saveKey(e: FormEvent) {
    e.preventDefault();
    try {
      sessionStorage.setItem("qp-api-key", draft);
    } catch {
      /* storage unavailable: key lives in memory only */
    }
    setApiKey(draft);
  }

  const rows = orders.map(toRow);

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Orders</h1>
        <div className="flex items-center gap-3 text-sm text-stone-500">
          {USE_FIXTURES && <span className="rounded bg-amber-100 px-2 py-0.5 text-amber-800">sample data</span>}
          <button onClick={() => void load()} className="rounded border border-stone-300 px-3 py-1 text-stone-700">
            Refresh
          </button>
        </div>
      </header>

      {!USE_FIXTURES && (
        <form onSubmit={saveKey} className="mb-6 flex gap-2">
          <input
            type="password"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="API key"
            aria-label="API key"
            className="w-72 rounded border border-stone-300 px-3 py-1.5 text-sm"
          />
          <button className="rounded bg-stone-900 px-3 py-1.5 text-sm text-white">Load orders</button>
        </form>
      )}

      {error && <p role="alert" className="mb-4 rounded bg-red-50 p-3 text-sm text-red-800">{error}</p>}
      {loading && <p className="mb-4 text-sm text-stone-500">Loading...</p>}

      <div className="overflow-x-auto rounded-lg border border-stone-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="bg-stone-50 text-xs uppercase text-stone-500">
            <tr>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Amount</th>
              <th className="px-3 py-2">Relay fee</th>
              <th className="px-3 py-2">Refund</th>
              <th className="px-3 py-2">Payout address</th>
              <th className="px-3 py-2">Payer</th>
              <th className="px-3 py-2">Created</th>
              <th className="px-3 py-2">Receipt</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-stone-100" data-testid="order-row">
                <td className="px-3 py-2">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[r.status]}`}>{r.status}</span>
                </td>
                <td className="px-3 py-2 font-medium">
                  {r.amount}
                  {r.reference && <div className="text-xs font-normal text-stone-400">{r.reference}</div>}
                </td>
                <td className="px-3 py-2">{r.fee}</td>
                <td className="px-3 py-2">
                  {r.refund ? (
                    <>
                      <div className="font-medium">{r.refund.label}</div>
                      <div className="whitespace-nowrap text-xs text-stone-600">{r.refund.refunded} refunded</div>
                      <div className="whitespace-nowrap text-xs text-stone-600">{r.refund.remaining} remaining</div>
                    </>
                  ) : r.status === "settled" ? <span className="text-stone-500">Unavailable</span> : <span>—</span>}
                </td>
                <td className="px-3 py-2 font-mono text-xs" title={r.payout}>{shortHex(r.payout)}</td>
                <td className="px-3 py-2 font-mono text-xs" title={r.payer ?? undefined}>{r.payer ? shortHex(r.payer) : "-"}</td>
                <td className="px-3 py-2 text-stone-500">{r.created}</td>
                <td className="px-3 py-2">
                  {r.explorerUrl ? (
                    <a className="text-blue-700 underline" href={r.explorerUrl} target="_blank" rel="noopener noreferrer">View</a>
                  ) : (
                    "-"
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && !loading && (
              <tr><td colSpan={8} className="px-3 py-6 text-center text-stone-400">No orders yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
