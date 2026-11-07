import { useCallback, useEffect, useState, type FormEvent } from "react";
import { formatUsdt } from "@quietpay/shared";
import { createPlan, intervals, listPlans, listSubscriptions, statusLabel, summarize, type Interval, type MerchantSubscription, type PlanView } from "./lib/subscriptions";

const STORE_URL = import.meta.env.VITE_STORE_URL || "http://localhost:5173";
export const signupLink = (planId: string) => `${STORE_URL.replace(/\/+$/, "")}/subscribe/${encodeURIComponent(planId)}`;

function CopyLink({ url }: { url: string }) {
  const [msg, setMsg] = useState("");
  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setMsg("Link copied.");
    } catch {
      setMsg("Copy the link from the box.");
    }
  }
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <input readOnly aria-label="Signup link" value={url} className="min-w-0 flex-1 rounded border border-stone-300 px-2 py-1 text-xs" onFocus={(e) => e.currentTarget.select()} />
      <button type="button" onClick={() => void copy()} className="rounded border border-stone-300 px-3 py-1 text-sm">Copy link</button>
      {msg && <span role="status" className="text-sm text-stone-600">{msg}</span>}
    </div>
  );
}

const every = (p: PlanView) => (p.intervalCount > 1 ? `every ${p.intervalCount} ${p.interval}s` : `per ${p.interval}`);
const fmtDate = (s: string | null) => (s ? s.slice(0, 10) : "—");

export function SubscriptionsPanel({ merchantUrl, token }: { merchantUrl: string; token?: string }) {
  const [plans, setPlans] = useState<PlanView[]>([]);
  const [subs, setSubs] = useState<MerchantSubscription[]>([]);
  const [error, setError] = useState("");
  const [formError, setFormError] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [interval, setIntervalValue] = useState<Interval>("month");
  const [count, setCount] = useState("1");

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError("");
    try {
      const o = { merchantUrl, token };
      const [p, s] = await Promise.all([listPlans(o), listSubscriptions(o)]);
      setPlans(p);
      setSubs(s);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [merchantUrl, token]);
  useEffect(() => {
    void load();
  }, [load]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setFormError("");
    const n = Number(count);
    if (!name.trim()) return setFormError("Give the plan a name.");
    if (!/^\d+(\.\d{1,6})?$/.test(amount.trim()) || Number(amount) <= 0) return setFormError("Enter an amount like 5.00 (up to 6 decimals).");
    if (!Number.isInteger(n) || n < 1) return setFormError("Every N must be a whole number of 1 or more.");
    setSaving(true);
    try {
      const plan = await createPlan({ merchantUrl, token: token ?? "" }, { name: name.trim(), amount: amount.trim(), interval, intervalCount: n });
      setPlans((cur) => [...cur, plan]);
      setName("");
      setAmount("");
      setCount("1");
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const { active, mrrBase } = summarize(subs);

  return (
    <section aria-labelledby="subs-title" className="md-glass mb-6 rounded-lg border border-stone-200 bg-white p-4 sm:p-5">
      <h2 id="subs-title" className="font-semibold">Subscriptions</h2>
      <p className="mt-1 text-sm text-stone-600">Each period your customer signs one gasless USDT payment; nothing is pulled automatically.</p>
      {!token && <p className="mt-3 text-sm text-stone-600">Sign in to manage subscriptions.</p>}
      {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
      {loading && <p role="status" className="mt-3 text-sm text-stone-600">Loading subscriptions…</p>}

      <dl className="my-4 flex flex-wrap gap-x-8 gap-y-2 text-sm">
        <div><dt className="text-xs text-stone-600">Active subscribers</dt><dd data-testid="subs-active" className="font-medium tabular-nums">{loading ? "—" : active}</dd></div>
        <div><dt className="text-xs text-stone-600">Monthly recurring revenue</dt><dd data-testid="subs-mrr" className="font-medium tabular-nums">{loading ? "—" : `${formatUsdt(mrrBase)} USDT`}</dd></div>
      </dl>

      <form onSubmit={(e) => void submit(e)} className="flex flex-wrap items-end gap-3" aria-label="Create plan">
        <label className="text-sm">Plan name<input name="name" value={name} onChange={(e) => setName(e.target.value)} className="mt-1 block rounded border border-stone-300 px-2 py-1" /></label>
        <label className="text-sm">Amount (USDT)<input name="amount" value={amount} inputMode="decimal" onChange={(e) => setAmount(e.target.value)} className="mt-1 block w-28 rounded border border-stone-300 px-2 py-1" /></label>
        <label className="text-sm">Interval<select name="interval" value={interval} onChange={(e) => setIntervalValue(e.target.value as Interval)} className="mt-1 block rounded border border-stone-300 px-2 py-1">{intervals.map((i) => <option key={i} value={i}>{i}</option>)}</select></label>
        <label className="text-sm">Every N<input name="count" value={count} inputMode="numeric" onChange={(e) => setCount(e.target.value)} className="mt-1 block w-16 rounded border border-stone-300 px-2 py-1" /></label>
        <button type="submit" disabled={saving || !token} className="rounded bg-stone-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50">{saving ? "Creating…" : "Create plan"}</button>
      </form>
      {formError && <p role="alert" className="mt-2 text-sm text-red-700">{formError}</p>}

      <h3 className="mt-5 text-sm font-semibold">Plans</h3>
      {plans.length === 0 ? <p className="mt-1 text-sm text-stone-600">No plans yet.</p> : (
        <ul className="divide-y divide-stone-200">
          {plans.map((p) => (
            <li key={p.id} className="py-3 text-sm"><strong>{p.name} · {p.amount} USDT {every(p)}</strong><CopyLink url={signupLink(p.id)} /></li>
          ))}
        </ul>
      )}

      <h3 className="mt-5 text-sm font-semibold">Subscribers</h3>
      {subs.length === 0 ? <p className="mt-1 text-sm text-stone-600">No subscribers yet.</p> : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead><tr><th className="px-3 py-2">Customer</th><th className="px-3 py-2">Plan</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Periods paid</th><th className="px-3 py-2">Next payment</th><th className="px-3 py-2">Last receipt</th></tr></thead>
            <tbody>
              {subs.map((s) => (
                <tr key={s.id} className="border-t border-stone-200">
                  <td className="px-3 py-2 font-mono" title={s.customer}>{s.customer.length > 14 ? `${s.customer.slice(0, 6)}...${s.customer.slice(-4)}` : s.customer}</td>
                  <td className="px-3 py-2">{s.plan.name}</td>
                  <td className="px-3 py-2">{statusLabel(s)}</td>
                  <td className="px-3 py-2 tabular-nums">{s.paidPeriods}</td>
                  <td className="px-3 py-2">{fmtDate(s.nextCharge)}</td>
                  <td className="px-3 py-2 font-mono">{s.lastPaidOrderId ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
