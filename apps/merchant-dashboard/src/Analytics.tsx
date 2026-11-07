import { useEffect, useMemo, useState, type ReactNode } from "react";
import { canReportMoney, displayUsdt, StatusBreakdown } from "./DashboardMetrics";
import { formatWbt } from "./lib/csv";
import { listSubscriptions, type MerchantSubscription } from "./lib/subscriptions";
import { fetchLedgerExport } from "./lib/ledger-download";
import { agentPayments, type AgentPayment } from "./lib/ledger-csv";
import { shortHex, type DashboardOrder } from "./lib/view";
import {
  agentInPeriod, changeLabel, customers, funnel, growth, heatmap, refundStats, revenueMix, speed,
  splitPeriods, subscriptionStats, unitEconomics, WEEKDAYS, type Change,
} from "./lib/analytics";

// Categorical slots 1-3 of the validated reference palette (blue, orange, aqua) and its blue for the sequential heatmap.
const MIX_COLORS = { checkout: "#2a78d6", subscription: "#eb6834", agent: "#1baf7a" } as const;
const HEAT = "#2a78d6";

const pct = (n: number | null) => (n === null ? "—" : `${n.toFixed(1)}%`);
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const hourLabel = (h: number) => `${String(h).padStart(2, "0")}:00`;

function Section({ id, title, takeaway, wide, children }: { id: string; title: string; takeaway: string; wide?: boolean; children?: ReactNode }) {
  return (
    <section className={"md-glass md-chart md-an-card" + (wide ? " md-an-wide" : "")} aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      <p className="md-an-takeaway">{takeaway}</p>
      {children}
    </section>
  );
}

function Delta({ change }: { change: Change }) {
  if (change.kind === "none") return null;
  const dir = change.kind === "pct" ? (change.pct > 0 ? "up" : "down") : change.kind === "new" ? "up" : "flat";
  return <span className="md-an-delta" data-dir={dir}>{changeLabel(change)}</span>;
}

function Stat({ label, value, sub, change }: { label: string; value: string; sub?: string; change?: Change }) {
  return (
    <div className="md-an-stat">
      <dt>{label}</dt>
      <dd><strong>{value}</strong>{change && <Delta change={change} />}</dd>
      {sub && <small>{sub}</small>}
    </div>
  );
}

export function Analytics({ orders, range, demo, merchantUrl, token, now }: {
  orders: DashboardOrder[]; range: string; demo: boolean; merchantUrl: string; token?: string; now?: number;
}) {
  const [subs, setSubs] = useState<MerchantSubscription[] | null>(null);
  const [agent, setAgent] = useState<AgentPayment[] | null>(null);

  useEffect(() => {
    setSubs(null); setAgent(null);
    if (demo || !token) return;
    let live = true;
    const o = { merchantUrl, token };
    listSubscriptions(o).then((v) => live && setSubs(v)).catch(() => undefined);
    fetchLedgerExport(o).then((v) => live && setAgent(agentPayments(v.csv))).catch(() => undefined);
    return () => { live = false; };
  }, [demo, merchantUrl, token]);

  const nowSec = now ?? Date.now() / 1000;
  const { current, previous, sinceSec } = useMemo(() => splitPeriods(orders, range, nowSec), [orders, range, nowSec]);
  const money = canReportMoney(current) && (!previous || canReportMoney(previous));
  const paidCount = current.filter((o) => ["settled", "partially_refunded", "refunded"].includes(o.status)).length;
  const periodLabel = range === "all" ? "all time" : `the last ${range} days`;

  if (current.length === 0) {
    return (
      <section className="md-glass md-chart md-an-card" aria-labelledby="an-empty-title">
        <h2 id="an-empty-title">No orders in this period yet</h2>
        <p className="md-an-takeaway">Once customers start paying, this view shows how your revenue grows, who your repeat customers are, when they pay and what each payment costs you.</p>
      </section>
    );
  }

  const g = growth(current, previous);
  const agentRows = agent ? agentInPeriod(agent, sinceSec) : null;
  const mix = revenueMix(current, demo ? null : agentRows);
  const cu = customers(current);
  const fu = funnel(current);
  const rf = refundStats(current);
  const sp = speed(current);
  const hm = heatmap(current);
  const ue = unitEconomics(current);
  const ss = subs ? subscriptionStats(subs) : null;
  const cmp = previous ? "vs the previous " + (range === "all" ? "period" : `${range} days`) : "No earlier period to compare with";
  const topMix = [...mix.segments].sort((a, b) => b.sharePct - a.sharePct)[0];

  return (
    <div className="md-an-grid">
      {!money && <p className="md-notice md-an-wide">Revenue figures need a single settlement token and complete refund amounts, so they are hidden here.</p>}

      {money && (
        <Section id="an-growth" wide title="Growth" takeaway={
          !previous ? "Pick Last 7 or 30 days above to compare against the period before."
            : g.net.change.kind === "pct" ? `Net revenue is ${g.net.change.pct > 0 ? "up" : "down"} ${Math.abs(g.net.change.pct).toFixed(1)}% ${cmp}.`
            : g.net.change.kind === "new" ? "Revenue is new: nothing was earned in the previous period."
            : "Net revenue is unchanged from the previous period."}>
          <dl className="md-an-stats">
            <Stat label="Net revenue" value={`${displayUsdt(g.net.current)} USDT`} change={g.net.change} sub={g.net.previous !== null ? `was ${displayUsdt(g.net.previous)} USDT` : cmp} />
            <Stat label="Paid orders" value={String(g.paid.current)} change={g.paid.change} sub={g.paid.previous !== null ? `was ${g.paid.previous}` : cmp} />
            <Stat label="Average order value" value={`${displayUsdt(g.aov.current)} USDT`} change={g.aov.change} sub={g.aov.previous !== null ? `was ${displayUsdt(g.aov.previous)} USDT` : cmp} />
          </dl>
        </Section>
      )}

      {money && (
        <Section id="an-mix" title="Revenue mix" takeaway={
          mix.total === 0n ? "No paid orders yet, so there is no mix to show."
            : `${topMix!.label} brings ${topMix!.sharePct.toFixed(1)}% of your gross revenue.`}>
          <div className="md-an-bar" role="img" aria-label={mix.segments.map((s) => `${s.label} ${s.sharePct.toFixed(1)}%`).join(", ")}>
            {mix.total === 0n ? <span className="md-an-bar-empty" /> : mix.segments.filter((s) => s.amount > 0n).map((s) => (
              <span key={s.key} title={s.label} style={{ flexGrow: Number(s.sharePct) * 10, background: MIX_COLORS[s.key] }} />
            ))}
          </div>
          <ul className="md-an-legend">
            {mix.segments.map((s) => (
              <li key={s.key}><i style={{ background: MIX_COLORS[s.key] }} /><span>{s.label}</span><strong>{displayUsdt(s.amount)} USDT</strong><small>{s.sharePct.toFixed(1)}% · {plural(s.count, "payment")}</small></li>
            ))}
          </ul>
          {!demo && !agentRows && <p className="md-an-note">Loading AI-agent (x402) payments from the on-chain ledger…</p>}
        </Section>
      )}

      <Section id="an-customers" title="Customers" takeaway={
        cu.unique === 0 ? "No paying wallets yet."
          : cu.repeat === 0 ? `${plural(cu.unique, "wallet")} paid so far and none has come back yet.`
          : `Repeat customers bring ${cu.repeatRevenuePct.toFixed(0)}% of your revenue.`}>
        <dl className="md-an-stats">
          <Stat label="Paying wallets" value={String(cu.unique)} />
          <Stat label="Repeat rate" value={cu.unique ? `${cu.repeatRatePct.toFixed(1)}%` : "—"} sub={`${plural(cu.repeat, "wallet")} with 2+ paid orders`} />
          {money && <Stat label="From repeat customers" value={`${displayUsdt(cu.repeatRevenue)} USDT`} />}
        </dl>
        {cu.top.length > 0 && (
          <div className="md-an-scroll"><table className="md-an-table">
            <caption>Top customers by net spend</caption>
            <thead><tr><th scope="col">Wallet</th><th scope="col">Orders</th>{money && <th scope="col">Net spend</th>}</tr></thead>
            <tbody>{cu.top.map((c) => (
              <tr key={c.address}><td className="font-mono" title={c.address}>{c.address.length > 14 ? shortHex(c.address) : c.address}</td><td>{c.orders}</td>{money && <td>{displayUsdt(c.spend)} USDT</td>}</tr>
            ))}</tbody>
          </table></div>
        )}
      </Section>

      <Section id="an-funnel" title="Checkout funnel" takeaway={
        fu.conversionPct === null ? "No checkouts yet."
          : `${fu.conversionPct.toFixed(1)}% of checkouts end in a payment${fu.abandoned ? `; ${plural(fu.abandoned, "checkout")} expired unpaid` : ""}.`}>
        <ol className="md-an-funnel">
          {([["Checkouts created", fu.created, 100], ["Paid", fu.paid, fu.conversionPct ?? 0], ["Kept (not fully refunded)", fu.kept, fu.created ? (100 * fu.kept) / fu.created : 0]] as const).map(([label, n, w]) => (
            <li key={label}><span>{label}</span><b style={{ width: `${Math.max(w, n ? 2 : 0)}%` }} /><strong>{n}</strong></li>
          ))}
        </ol>
        <p className="md-an-note">Abandoned (expired): {fu.abandoned} · Failed: {fu.failed} · Still open: {fu.open} · Paid to kept: {pct(fu.keptPct)}</p>
      </Section>

      {money && (
        <Section id="an-refunds" title="Refunds" takeaway={
          rf.paid === 0 ? "No paid orders yet, so nothing to refund."
            : rf.refundedOrders === 0 ? "No refunds in this period."
            : `${rf.ratePct!.toFixed(1)}% of paid orders had a refund.`}>
          <dl className="md-an-stats">
            <Stat label="Refund rate" value={pct(rf.ratePct)} sub={`${rf.refundedOrders} of ${rf.paid} paid orders`} />
            <Stat label="Refunded" value={`${displayUsdt(rf.refunded)} USDT`} sub={`${rf.refundedPctOfGross.toFixed(1)}% of gross`} />
            {!demo && <Stat label="Relay fee lost" value={`${displayUsdt(rf.feeLost)} USDT`} sub="on fully refunded orders" />}
          </dl>
        </Section>
      )}

      {!demo && (
        <Section id="an-speed" title="Speed" takeaway={
          sp.median === undefined ? "No settled payments yet to time."
            : `Customers confirm payment in a median of ${Math.round(sp.median)}s.`}>
          <dl className="md-an-stats">
            <Stat label="Median" value={sp.median === undefined ? "—" : `${Math.round(sp.median)}s`} />
            <Stat label="90th percentile" value={sp.p90 === undefined ? "—" : `${Math.round(sp.p90)}s`} sub="9 in 10 payments are faster" />
          </dl>
        </Section>
      )}

      <Section id="an-heat" wide title="When customers pay (UTC)" takeaway={
        hm.busiest ? `Your busiest slot is ${hm.busiest.day} ${hourLabel(hm.busiest.hour)} UTC with ${plural(hm.busiest.count, "payment")}.` : "No paid orders yet, so there is no busy time to show."}>
        <p className="md-an-note" data-testid="heatmap-summary">
          {hm.busiest ? `${plural(hm.total, "paid order")} in ${periodLabel}. Busiest: ${hm.busiest.day} ${hourLabel(hm.busiest.hour)} UTC (${hm.busiest.count}).` : "Nothing to plot yet."}
        </p>
        <div className="md-an-scroll">
          <svg viewBox="0 0 540 190" className="md-an-heat" role="img" aria-label={`Paid orders by weekday and hour, UTC. ${hm.busiest ? `Busiest ${hm.busiest.day} ${hourLabel(hm.busiest.hour)}.` : "No paid orders."}`}>
            {hm.cells.map((row, r) => (
              <g key={WEEKDAYS[r]}>
                <text x="0" y={20 + r * 22 + 12} fontSize="11" fill="currentColor">{WEEKDAYS[r]}</text>
                {row.map((n, h) => (
                  <rect key={h} x={36 + h * 21} y={20 + r * 22} width="19" height="20" rx="3" fill={n ? HEAT : "#c8dfef"} fillOpacity={n ? 0.2 + 0.8 * (n / hm.max) : 0.45}>
                    <title>{`${WEEKDAYS[r]} ${hourLabel(h)} UTC: ${plural(n, "paid order")}`}</title>
                  </rect>
                ))}
              </g>
            ))}
            {[0, 6, 12, 18, 23].map((h) => <text key={h} x={36 + h * 21 + 9.5} y="12" fontSize="10" textAnchor="middle" fill="currentColor">{String(h).padStart(2, "0")}</text>)}
          </svg>
        </div>
      </Section>

      {!demo && money && (
        <Section id="an-unit" title="Unit economics per paid order" takeaway={
          ue.paid === 0 ? "No paid orders yet, so no per-order costs."
            : `Each payment costs you about ${displayUsdt(ue.avgFee)} USDT in relay fees (${ue.feePctOfGross.toFixed(2)}% of the sale).`}>
          <dl className="md-an-stats">
            <Stat label="Average relay fee" value={`${displayUsdt(ue.avgFee)} USDT`} sub={`${ue.feePctOfGross.toFixed(2)}% of gross`} />
            <Stat label="Average network gas covered" value={ue.avgGasWei === null ? "—" : `${formatWbt(ue.avgGasWei, 6)} WBT`} sub={ue.avgGasWei === null ? "Not reported by this relayer" : "paid by the relayer, not your customer"} />
          </dl>
        </Section>
      )}

      {!demo && ss && (
        <Section id="an-subs" title="Subscriptions" takeaway={
          ss.total === 0 ? "No subscribers yet."
            : `${plural(ss.active, "active subscriber")} bring ${displayUsdt(ss.mrrBase)} USDT a month${ss.churnPct ? `; ${ss.churnPct.toFixed(1)}% have churned` : ""}.`}>
          <dl className="md-an-stats">
            <Stat label="Active" value={String(ss.active)} />
            <Stat label="Past due" value={String(ss.pastDue)} />
            <Stat label="Churned (cancelled)" value={String(ss.cancelled)} sub="all time: cancellation dates are not recorded" />
            <Stat label="Monthly recurring revenue" value={`${displayUsdt(ss.mrrBase)} USDT`} />
            <Stat label="Churn rate" value={pct(ss.churnPct)} />
          </dl>
        </Section>
      )}

      <div className="md-an-wide md-an-status"><StatusBreakdown orders={current} /></div>
      {paidCount === 0 && <p className="md-an-note md-an-wide">None of these orders is paid yet, so most figures above are still empty.</p>}
    </div>
  );
}
