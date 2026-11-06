import { RefundPanel } from "./RefundPanel";
import { LedgerExport } from "./LedgerExport";
import { BillingWorkspace } from "./BillingWorkspace";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import { OrderStatus, type Order } from "@quietpay/shared";
import { DashboardError, listOrders } from "./lib/api";
import { STATUS_STYLES, shortHex, toRow } from "./lib/view";

const MERCHANT_URL = import.meta.env.VITE_MERCHANT_API_URL || "/api/merchant";
const USE_FIXTURES = import.meta.env.VITE_USE_FIXTURES === "1";
const statusText = (status: string) => status.replace(/_/g, " ");

function loadKey(): string {
  try {
    return sessionStorage.getItem("qp-dashboard-token") ?? "";
  } catch {
    return "";
  }
}

export function App() {
  const [selected, setSelected] = useState<Order>();
  const [apiKey, setApiKey] = useState(loadKey);
  const [draft, setDraft] = useState("");
  const [orders, setOrders] = useState<Order[]>([]);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("all");

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      setOrders(
        await listOrders({
          merchantUrl: MERCHANT_URL,
          apiKey,
          useFixtures: USE_FIXTURES,
        }),
      );
    } catch (e) {
      setOrders([]);
      setError(
        e instanceof DashboardError
          ? e.message
          : "Something went wrong loading orders.",
      );
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
      sessionStorage.setItem("qp-dashboard-token", draft);
    } catch {
      /* storage unavailable: key lives in memory only */
    }
    setSelected(undefined);
    setApiKey(draft);
  }

  const rows = orders.filter((order) => filter === "all" || filter === order.status).map(toRow);
  const refundOptions = useMemo(
    () => ({ merchantUrl: MERCHANT_URL, apiKey }),
    [apiKey],
  );

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Orders</h1>
        <div className="flex items-center gap-3 text-sm text-stone-500">
          {USE_FIXTURES && (
            <span className="rounded bg-amber-100 px-2 py-0.5 text-amber-800">
              sample data
            </span>
          )}
          <button
            onClick={() => void load()}
            className="rounded border border-stone-300 px-3 py-1 text-stone-700"
          >
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
            placeholder="Dashboard access token"
            aria-label="Dashboard access token"
            className="w-72 rounded border border-stone-300 px-3 py-1.5 text-sm"
          />
          <button className="rounded bg-stone-900 px-3 py-1.5 text-sm text-white">
            Load orders
          </button>
        </form>
      )}

      {error && (
        <p
          role="alert"
          className="mb-4 rounded bg-red-50 p-3 text-sm text-red-800"
        >
          {error}
        </p>
      )}
      {loading && <p className="mb-4 text-sm text-stone-500">Loading...</p>}
      <LedgerExport useFixtures={USE_FIXTURES} />
      {USE_FIXTURES && <BillingWorkspace />}
      <label className="mb-3 flex items-center gap-2 text-sm">Order status
        <select className="rounded border border-stone-300 px-2 py-1" value={filter} onChange={(event) => setFilter(event.target.value)}>
          <option value="all">All statuses</option>
          {OrderStatus.options.map((status) => <option value={status} key={status}>{statusText(status)}</option>)}
        </select>
      </label>

      {selected && (
        <RefundPanel
          key={`${selected.id}:${apiKey}`}
          order={selected}
          options={refundOptions}
          onChanged={() => void load()}
          onClose={() => setSelected(undefined)}
        />
      )}

      <div className="overflow-x-auto rounded-lg border border-stone-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="bg-stone-50 text-xs uppercase text-stone-500">
            <tr>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Amount</th>
              <th className="px-3 py-2">Relay fee</th>
              <th className="px-3 py-2">Payout address</th>
              <th className="px-3 py-2">Payer</th>
              <th className="px-3 py-2">Created</th>
              <th className="px-3 py-2">Receipt</th>
              <th className="px-3 py-2">Refunds</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.id}
                className="border-t border-stone-100"
                data-testid="order-row"
              >
                <td className="px-3 py-2">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[r.status]}`}
                  >
                    {statusText(r.status)}
                  </span>
                </td>
                <td className="px-3 py-2 font-medium">
                  {r.amount}
                  {r.reference && (
                    <div className="text-xs font-normal text-stone-400">
                      {r.reference}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2">{r.fee}</td>
                <td className="px-3 py-2 font-mono text-xs" title={r.payout}>
                  {shortHex(r.payout)}
                </td>
                <td
                  className="px-3 py-2 font-mono text-xs"
                  title={r.payer ?? undefined}
                >
                  {r.payer ? shortHex(r.payer) : "-"}
                </td>
                <td className="px-3 py-2 text-stone-500">{r.created}</td>
                <td className="px-3 py-2">
                  {r.explorerUrl ? (
                    <a
                      className="text-blue-700 underline"
                      href={r.explorerUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      View
                    </a>
                  ) : (
                    "-"
                  )}
                </td>
                <td className="px-3 py-2">
                  {r.refund && <div className="mb-1 text-xs text-stone-600">
                    <div>{r.refund.refunded} refunded</div><div>{r.refund.remaining} remaining</div>
                    {r.refund.count !== undefined && <div>{r.refund.count} {r.refund.count === 1 ? "refund" : "refunds"}</div>}
                  </div>}
                  {["settled", "partially_refunded", "refunded"].includes(
                    r.status,
                  ) && (
                    <button
                      type="button"
                      disabled={USE_FIXTURES}
                      title={
                        USE_FIXTURES
                          ? "Connect the merchant server to manage refunds"
                          : undefined
                      }
                      onClick={() =>
                        setSelected(orders.find((o) => o.id === r.id))
                      }
                      className="rounded border border-stone-300 px-3 py-1 text-sm disabled:opacity-40"
                    >
                      {r.status === "refunded" ? "View refunds" : "Refund"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && !loading && (
              <tr>
                <td
                  colSpan={8}
                  className="px-3 py-6 text-center text-stone-400"
                >
                  No orders yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
