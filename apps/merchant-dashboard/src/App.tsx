import { billingRequest, type DemoOrder } from "../../demo-store/src/billing";
import quietPayLogo from "../../demo-store/public/brand/quietpay-wordmark.png?url";
import { DashboardMetrics, canReportMoney, displayUsdt, orderNet, paidOrder } from "./DashboardMetrics";
import { RefundPanel } from "./RefundPanel";
import { LedgerExport } from "./LedgerExport";
import { BillingWorkspace } from "./BillingWorkspace";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { OrderStatus, type Order } from "@quietpay/shared";
import { DashboardError, listOrders } from "./lib/api";
import { WalletLoginError, injectedProvider, shortAddress, signInWithWallet, signOut } from "./lib/wallet-login";
import { STATUS_STYLES, demoOrderToDashboard, safeHttpUrl, shortHex, toRow, type DashboardOrder } from "./lib/view";

const MERCHANT_URL = import.meta.env.VITE_MERCHANT_API_URL || "/api/merchant";
const DEMO_MODE = import.meta.env.VITE_DEMO_MODE === "1" || import.meta.env.VITE_USE_FIXTURES === "1";
const merchantName = import.meta.env.VITE_MERCHANT_NAME?.trim() || "Quiet Store";
const statusText = (status: string) => status.replace(/_/g, " ");

const views = ["Overview", "Transactions", "Refunds", "Analytics", "Billing", "Settings"] as const;
type View = (typeof views)[number];

function loadKey(): string {
  try {
    return sessionStorage.getItem("qp-dashboard-token") ?? "";
  } catch {
    return "";
  }
}

function loadWalletAddress(): string {
  try {
    return sessionStorage.getItem("qp-wallet-address") ?? "";
  } catch {
    return "";
  }
}

function loadDemoSession(): boolean {
  try {
    return sessionStorage.getItem("qp-merchant-demo") === "1";
  } catch {
    return false;
  }
}

export function App() {
  const [selected, setSelected] = useState<Order>();
  const [apiKey, setApiKey] = useState(loadKey);
  const [demoSession, setDemoSession] = useState(loadDemoSession);
  const [draft, setDraft] = useState("");
  const [wallet, setWallet] = useState(loadWalletAddress);
  const [walletBusy, setWalletBusy] = useState(false);
  const [walletError, setWalletError] = useState<string>();
  const [orders, setOrders] = useState<DashboardOrder[]>([]);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("all");
  const [view, setView] = useState<View>("Overview");
  const [range, setRange] = useState("all");
  const request = useRef(0);
  const activeToken = useRef(apiKey);

  function changeView(next: View) {
    setView(next);
    setFilter("all");
    setSelected(undefined);
  }

  async function walletLogin() {
    setWalletError(undefined);
    setWalletBusy(true);
    try {
      const session = await signInWithWallet({ merchantUrl: MERCHANT_URL, provider: injectedProvider() });
      request.current++;
      activeToken.current = session.token;
      setOrders([]);
      try {
        sessionStorage.setItem("qp-dashboard-token", session.token);
        sessionStorage.setItem("qp-wallet-address", session.address);
      } catch { /* storage unavailable: the session lives in memory only */ }
      setWallet(session.address);
      setApiKey(session.token);
      setDraft("");
      changeView("Overview");
    } catch (e) {
      setWalletError(e instanceof WalletLoginError ? e.message : "Wallet sign-in failed.");
    } finally {
      setWalletBusy(false);
    }
  }

  function disconnect() {
    if (wallet && apiKey) void signOut({ merchantUrl: MERCHANT_URL, token: apiKey });
    setWallet("");
    setWalletError(undefined);
    try { sessionStorage.removeItem("qp-wallet-address"); } catch { /* Storage may be unavailable. */ }
    request.current++;
    activeToken.current = "";
    try { sessionStorage.removeItem(DEMO_MODE ? "qp-merchant-demo" : "qp-dashboard-token"); } catch { /* Storage may be unavailable. */ }
    if (DEMO_MODE) setDemoSession(false);
    setApiKey("");
    setDraft("");
    setOrders([]);
    setSelected(undefined);
    setError(undefined);
    setLoading(false);
    changeView("Overview");
  }

  function startDemo() {
    try { sessionStorage.setItem("qp-merchant-demo", "1"); } catch { /* Keep the session in memory. */ }
    setDemoSession(true);
  }

  const load = useCallback(async () => {
    if (apiKey !== activeToken.current) return;
    const current = ++request.current;
    setLoading(true);
    setError(undefined);
    try {
      const result = DEMO_MODE
        ? (await billingRequest<{ orders: DemoOrder[] }>("/api/demo/merchant/orders", { cache: "no-store" })).orders.map(demoOrderToDashboard)
        : await listOrders({ merchantUrl: MERCHANT_URL, apiKey });
      if (current === request.current) setOrders(result);
    } catch (e) {
      if (current !== request.current) return;
      setOrders([]);
      setError(
        e instanceof DashboardError
          ? e.message
          : DEMO_MODE ? "Could not load Quiet Store demo orders. Check that the demo store API is running." : "Something went wrong loading orders.",
      );
    } finally {
      if (current === request.current) setLoading(false);
    }
  }, [apiKey]);

  useEffect(() => {
    if (DEMO_MODE ? demoSession : apiKey) void load();
  }, [apiKey, demoSession, load]);

  function saveKey(e: FormEvent) {
    e.preventDefault();
    const token = draft.trim();
    if (!token) return;
    if (token === apiKey) {
      void load();
      return;
    }
    request.current++;
    activeToken.current = token;
    setOrders([]);
    try {
      sessionStorage.setItem("qp-dashboard-token", token);
    } catch {
      /* storage unavailable: key lives in memory only */
    }
    setApiKey(token);
    setDraft("");
    changeView("Overview");
  }

  const latest = Date.now() / 1000;
  const periodOrders = orders.filter((order) => range === "all" || order.createdAt >= latest - Number(range) * 86400)
    .sort((a, b) => b.createdAt - a.createdAt);
  const matching = periodOrders.filter((order) => (view !== "Refunds" || paidOrder(order)) && (filter === "all" || filter === order.status));
  const rows = (view === "Overview" ? matching.slice(0, 5) : matching).map((order) => ({
    ...toRow(order),
    ...(DEMO_MODE ? { fee: "—" } : {}),
    net: paidOrder(order) && canReportMoney([order]) ? displayUsdt(orderNet(order)) + " USDT" : "—",
  }));
  const showTable = view === "Overview" || view === "Transactions" || view === "Refunds";
  const hasAccess = DEMO_MODE || Boolean(apiKey);
  const refundOptions = useMemo(
    () => ({ merchantUrl: MERCHANT_URL, apiKey }),
    [apiKey],
  );

  if (DEMO_MODE ? !demoSession : !apiKey) {
    return (
      <main className="md-shell md-signin">
        <section className="md-glass md-signin-card" aria-labelledby="merchant-signin-title">
          <div className="md-brand"><span role="img" aria-label="QuietPay" style={{ maskImage: `url("${quietPayLogo}")` }} /></div>
          <div className="md-signin-tag">{DEMO_MODE ? "DEMO WORKSPACE" : "MERCHANT ACCESS"}</div>
          <h1 id="merchant-signin-title">Merchant verification</h1>
          <p>{DEMO_MODE ? "Preview how a merchant enters the dashboard. Verification is simulated for this demo." : "Enter your dashboard access token to open your merchant workspace."}</p>
          {DEMO_MODE ? (
            <>
              <div className="md-signin-account"><span>Demo merchant</span><strong>{merchantName}</strong></div>
              <button type="button" className="md-signin-submit" onClick={startDemo}>Continue as demo merchant <span aria-hidden="true">→</span></button>
            </>
          ) : (
            <form onSubmit={saveKey}>
              <label>Dashboard access token<input type="password" value={draft} onChange={(e) => setDraft(e.target.value)} autoComplete="off" required /></label>
              <button type="submit" className="md-signin-submit">Open merchant dashboard <span aria-hidden="true">→</span></button>
              <button type="button" className="md-signin-submit" disabled={walletBusy} onClick={() => void walletLogin()}>{walletBusy ? "Waiting for wallet…" : "Sign in with MetaMask"}</button>
              {walletError && <p role="alert" className="md-notice">{walletError}</p>}
            </form>
          )}
        </section>
      </main>
    );
  }

  return (
    <div className="md-shell">
      <aside className="md-glass md-sidebar">
        <div className="md-brand">
          <span role="img" aria-label="QuietPay" style={{ maskImage: `url("${quietPayLogo}")` }} />
        </div>
        <nav aria-label="Merchant navigation">
          {views.filter((item) => item !== "Billing" || DEMO_MODE).map((item) => (
            <button key={item} type="button" aria-current={view === item ? "page" : undefined} onClick={() => changeView(item)}>{item}</button>
          ))}
        </nav>
        <div className="md-side-note"><strong>{merchantName}</strong><span>{DEMO_MODE ? "Storefront demo" : wallet ? "Signed in as " + shortAddress(wallet) : "Dashboard token access"}</span></div>
      </aside>
      <main className="md-main">
        <header className="md-top">
          <span className="md-glass md-connection"><i data-active={hasAccess && !error && !loading} />{loading ? "Loading orders" : error ? "Connection needs attention" : DEMO_MODE ? "Storefront demo" : hasAccess ? "Merchant server" : "Access required"}</span>
          <div className="md-actions">
            <label className="md-glass md-range">Order date <select value={range} onChange={(event) => setRange(event.target.value)}>
              <option value="all">All time</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option>
            </select></label>
            <button className="md-glass" disabled={!hasAccess || loading} onClick={() => void load()}>Refresh</button>
          </div>
        </header>
        <div className="md-heading"><h1>{view}</h1><p>{view === "Overview" ? "Your payments at a glance" : view === "Refunds" ? "Review refunds and manage eligible payments." : merchantName + " merchant workspace"}</p></div>
        {!DEMO_MODE && (!hasAccess || view === "Settings") && (
          <form onSubmit={saveKey} className="md-glass md-access">
            <label>Dashboard access token<input type="password" value={draft} onChange={(e) => setDraft(e.target.value)} autoComplete="off" required /></label>
            <button type="submit">Load orders</button>
            {!hasAccess && <button type="button" disabled={walletBusy} onClick={() => void walletLogin()}>{walletBusy ? "Waiting for wallet…" : "Sign in with MetaMask"}</button>}
            {wallet && hasAccess && <span>Signed in as {shortAddress(wallet)}</span>}
            {hasAccess && <button type="button" onClick={disconnect}>Sign out</button>}
            {walletError && <p role="alert" className="md-notice">{walletError}</p>}
          </form>
        )}
        {DEMO_MODE && view === "Settings" && <div className="md-glass md-access"><p>This workspace shows payments recorded by the demo storefront. Connect the merchant server to see live orders.</p><button type="button" onClick={disconnect}>Sign out</button></div>}
        {error && <p role="alert" className="md-notice">{error}</p>}
        {loading && <p role="status" className="md-notice">Loading orders…</p>}
        {(view === "Overview" || view === "Analytics") && <DashboardMetrics orders={periodOrders} demo={DEMO_MODE} />}
        {view === "Analytics" && <LedgerExport useFixtures={false} />}
        {DEMO_MODE && (view === "Billing" || view === "Refunds") && <BillingWorkspace key={view} onRefundRecorded={load} />}
        {showTable && <section className="md-glass md-orders" aria-labelledby="orders-title">
          <div className="md-orders-heading">
            <h2 id="orders-title">{view === "Overview" ? "Recent payments" : view === "Refunds" ? "Refundable and refunded payments" : "All transactions"}</h2>
            {view === "Overview" && <button onClick={() => changeView("Transactions")}>View all transactions →</button>}
          </div>
          {view !== "Overview" && (
      <label className="mb-3 flex items-center gap-2 text-sm">Order status
        <select className="rounded border border-stone-300 px-2 py-1" value={filter} onChange={(event) => setFilter(event.target.value)}>
          <option value="all">All statuses</option>
          {OrderStatus.options.map((status) => <option value={status} key={status}>{statusText(status)}</option>)}
        </select>
      </label>)}

      {selected && (
        <RefundPanel
          key={`${selected.id}:${apiKey}`}
          order={selected}
          options={refundOptions}
          onChanged={() => void load()}
          onClose={() => setSelected(undefined)}
        />
      )}

      <div className="md-table-wrap">
        <table className="w-full text-left text-sm">
          <thead className="bg-stone-50 text-xs uppercase text-stone-500">
            <tr>
              <th className="px-3 py-2">Order ID</th><th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Amount</th>
              <th className="px-3 py-2">Relay fee</th><th className="px-3 py-2">{DEMO_MODE ? "After refunds" : "Net"}</th>
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
                <td className="px-3 py-2 font-mono text-xs" title={r.id}>{r.reference || shortHex(r.id)}</td>
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
                <td className="px-3 py-2">{r.fee}</td><td className="px-3 py-2">{r.net}</td>
                <td className="px-3 py-2 font-mono text-xs" title={r.payout ?? undefined}>
                  {r.payout ? shortHex(r.payout) : "—"}
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
                  {!DEMO_MODE && ["settled", "partially_refunded", "refunded"].includes(r.status) && (
                    <button
                      type="button"
                      onClick={() => setSelected(orders.find((order): order is Order => order.id === r.id && "merchantId" in order))}
                      className="rounded border border-stone-300 px-3 py-1 text-sm"
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
                  colSpan={10}
                  className="px-3 py-6 text-center text-stone-400"
                >
                  {!hasAccess ? "Enter a dashboard access token to load orders." : DEMO_MODE && !orders.length ? "Complete a checkout in Quiet Store, then refresh to see the payment here." : "No orders match this view."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      </section>}
      </main>
    </div>
  );
}
