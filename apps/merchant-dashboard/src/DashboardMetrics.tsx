import { formatUsdt, OrderStatus, token } from "@quietpay/shared";
import type { DashboardOrder } from "./lib/view";
import { formatWbt } from "./lib/csv";

const paidStatuses = new Set(["settled", "partially_refunded", "refunded"]);
const colors = ["#8194ad", "#cc8718", "#138453", "#d44945", "#667384", "#426fe0", "#754ab2"];

export function paidOrder(order: DashboardOrder) {
  return paidStatuses.has(order.status);
}

export function orderNet(order: DashboardOrder) {
  return BigInt(order.amount) - BigInt(order.fee) - BigInt(order.refunded ?? (order.status === "refunded" ? order.amount : "0"));
}

export function displayUsdt(value: bigint) {
  const sign = value < 0n ? "−" : "";
  return sign + formatUsdt(value < 0n ? -value : value).replace(/\B(?=(\d{3})+\.)/g, ",");
}

export function canReportMoney(orders: DashboardOrder[]) {
  return new Set(orders.map(({ checkout }) => checkout ? `${checkout.chainId}:${checkout.token.toLowerCase()}` : "demo")).size <= 1 &&
    orders.every((order) => order.status !== "partially_refunded" || order.refunded !== undefined);
}

/** Plain words for the chart legend: "created" is a checkout that has not been paid (yet). */
const STATUS_LABELS: Partial<Record<string, string>> = { created: "open (not paid yet)", pending: "paying", expired: "expired (abandoned)" };

export interface Metric { label: string; value: string; unit: string; icon: string; detail: string }

/**
 * The four overview cards. Pure, so the numbers and their explanations can be tested.
 * - Net revenue = per paid order: amount - relay fee - refunded. It is negative when a refund is larger than what the
 *   merchant received, because the relay fee is not returned to the payer on a refund.
 * - Checkout completion = paid / (paid + failed + expired). Abandoned carts expire after about 10 minutes and are
 *   counted here, not called payment failures; checkouts still open are not decided yet and are left out.
 */
export function buildMetrics(orders: DashboardOrder[], demo: boolean): Metric[] {
  const paid = orders.filter(paidOrder);
  const gross = paid.reduce((sum, order) => sum + BigInt(order.amount), 0n);
  const net = paid.reduce((sum, order) => sum + orderNet(order), 0n);
  const decided = paid.length + orders.filter((order) => order.status === "failed" || order.status === "expired").length;
  const open = orders.filter((order) => order.status === "created" || order.status === "pending").length;
  const monetary = orders.length > 0 && canReportMoney(orders);
  const netDetail = demo
    ? "Relay fees excluded from this feed"
    : net < 0n
      ? "Negative because refunds were larger than what you received: the relay fee is not returned on a refund"
      : "After relay fees and refunds";
  const fees = paid.reduce((sum, order) => sum + BigInt(order.fee), 0n);
  const gasKnown = orders.some((order) => order.gasWei !== undefined);
  const gas = orders.reduce((sum, order) => sum + BigInt(order.gasWei ?? "0"), 0n);
  const costCards: Metric[] = demo
    ? []
    : [
        { label: "Relay fees paid", value: monetary ? displayUsdt(fees) : "—", unit: "USDT", icon: "⛽", detail: `What you pay QuietPay for gasless checkout · ${paid.length} paid order${paid.length === 1 ? "" : "s"}` },
        {
          label: "Network gas covered",
          value: gasKnown ? formatWbt(gas, 6) : "—",
          unit: "WBT",
          icon: "⛓",
          detail: !orders.length
            ? "Appears once you have orders"
            : gasKnown
              ? "Gas the relayer paid on-chain for your payments, refunds and retries (your customers paid none)"
              : "Not reported by this relayer",
        },
      ];
  return [
    { label: demo ? "Demo payments after refunds" : "Net revenue", value: monetary ? displayUsdt(net) : "—", unit: "USDT", icon: "↗", detail: netDetail },
    { label: "Successful payments", value: String(paid.length), unit: "", icon: "✓", detail: "Includes orders later refunded" },
    { label: "Average order value", value: monetary && paid.length ? displayUsdt(gross / BigInt(paid.length)) : "—", unit: "USDT", icon: "◇", detail: "Based on gross paid orders" },
    {
      label: demo ? "Payment success rate" : "Checkout completion rate",
      value: !demo && decided ? `${(100 * paid.length / decided).toFixed(1)}%` : "—",
      unit: "",
      icon: "%",
      detail: demo ? "Demo feed records completed payments" : `Paid out of finished checkouts (paid, failed or abandoned) · ${open} still open`,
    },
    ...costCards,
  ];
}

export function DashboardMetrics({ orders, demo, charts = "overview" }: { orders: DashboardOrder[]; demo: boolean; charts?: "overview" | "none" }) {
  const metrics = buildMetrics(orders, demo);
  const monetary = orders.length > 0 && canReportMoney(orders);
  const paid = orders.filter(paidOrder);

  const byDay = new Map<string, { gross: bigint; net: bigint }>();
  for (const order of paid) {
    const date = new Date((order.settledAt ?? order.createdAt) * 1000).toISOString().slice(0, 10);
    const point = byDay.get(date) ?? { gross: 0n, net: 0n };
    point.gross += BigInt(order.amount);
    point.net += orderNet(order);
    byDay.set(date, point);
  }
  const days = [...byDay].sort(([a], [b]) => a.localeCompare(b));
  const unit = 10 ** token.decimals;
  const high = Math.max(1, ...days.map(([, point]) => Number(point.gross) / unit));
  const low = Math.min(0, ...days.map(([, point]) => Number(point.net) / unit));
  const y = (value: bigint) => 16 + 128 * (high - Number(value) / unit) / (high - low);
  const x = (index: number) => days.length === 1 ? 270 : 18 + 504 * index / (days.length - 1);

  return (
    <>
      <div className="md-metrics">
        {metrics.map(({ label, value, unit, icon, detail }) => (
          <article className="md-glass md-metric" key={label}>
            <h2><span aria-hidden="true">{icon}</span>{label}</h2>
            <strong>{value} <small>{unit}</small></strong>
            <p>{detail}</p>
          </article>
        ))}
      </div>
      {orders.length > 0 && !monetary && <p className="md-notice">Revenue requires a single settlement token and complete refund amounts.</p>}
      {charts === "overview" && <div className="md-charts">
        <section className="md-glass md-chart" aria-labelledby="revenue-title">
          <h2 id="revenue-title">Revenue over time</h2>
          <div className="md-legend"><span><i style={{ background: "#145ed6" }} />Gross payments</span><span><i style={{ background: "#138453" }} />{demo ? "After refunds" : "Net revenue"}</span></div>
          {monetary && days.length ? <>
            <svg viewBox="0 0 540 160" aria-hidden="true" className="md-revenue">
              {[16, 48, 80, 112, 144].map((line) => <line key={line} x1="18" x2="522" y1={line} y2={line} stroke="#a8c3dc" />)}
              {(["gross", "net"] as const).map((key, index) => (
                <g key={key} fill={index ? "#138453" : "#145ed6"}>
                  <polyline points={days.map(([, point], i) => `${x(i)},${y(point[key])}`).join(" ")} stroke={index ? "#138453" : "#145ed6"} strokeWidth="3" fill="none" />
                  {days.map(([date, point], i) => <circle key={date} cx={x(i)} cy={y(point[key])} r="4"><title>{date} · {displayUsdt(point[key])} USDT</title></circle>)}
                </g>
              ))}
            </svg>
            <p className="md-chart-dates"><span>{days[0][0]}</span>{days.length > 1 && <span>{days[days.length - 1][0]}</span>}</p>
            <details className="md-chart-data"><summary>View daily totals (UTC)</summary><ul>{days.map(([date, point]) => <li key={date}>{date} · Gross {displayUsdt(point.gross)} USDT · Net {displayUsdt(point.net)} USDT</li>)}</ul></details>
          </> : <p className="md-empty">Revenue will appear when reportable payments are available.</p>}
        </section>
        <StatusBreakdown orders={orders} />
      </div>}
    </>
  );
}

/** Payment status donut with legend (on Overview next to the revenue chart, and on Analytics). */
export function StatusBreakdown({ orders }: { orders: DashboardOrder[] }) {
  let cursor = 0;
  const statuses = OrderStatus.options.map((status, index) => {
    const count = orders.filter((order) => order.status === status).length;
    const start = cursor;
    cursor += orders.length ? 100 * count / orders.length : 0;
    return { status, count, color: colors[index], stop: `${colors[index]} ${start}% ${cursor}%` };
  });
  const stops = statuses.filter(({ count }) => count).map(({ stop }) => stop);
  return (
    <section className="md-glass md-chart" aria-labelledby="status-title">
      <h2 id="status-title">Payment status breakdown</h2>
      <div className="md-status-chart">
        <div className="md-donut" aria-hidden="true" style={{ background: stops.length ? `conic-gradient(${stops.join(", ")})` : "#bad1e4" }}><span>{orders.length}<small>orders</small></span></div>
        <ul>{statuses.map(({ status, count, color }) => <li key={status}><i style={{ background: color }} /><span>{STATUS_LABELS[status] ?? status.replace(/_/g, " ")}</span><strong>{count}</strong></li>)}</ul>
      </div>
    </section>
  );
}
