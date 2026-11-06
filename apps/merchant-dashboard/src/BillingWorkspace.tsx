import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  billingPost, billingRequest, invoiceStatus,
  type DemoInvoice, type DemoOrder, type DemoPlan, type DemoSubscription,
} from "../../demo-store/src/billing";

const primary = "rounded bg-stone-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50";
const secondary = "rounded border border-stone-300 px-3 py-2 text-sm hover:bg-stone-50 disabled:opacity-50";
const field = "mt-1 block w-full rounded border border-stone-300 px-2.5 py-2";
const tabs = ["Refunds", "Invoices & links", "Subscriptions"] as const;

function remaining(order: DemoOrder) {
  const cents = (value: string) => Math.round(Number(value) * 100);
  return ((cents(order.amount) - order.refunds.reduce((sum, refund) => sum + cents(refund.amount), 0)) / 100).toFixed(2);
}

function storefrontLink(path: string) {
  const origin = import.meta.env.VITE_DEMO_STORE_URL || "http://localhost:5173";
  return new URL(path, origin).href;
}

function ShareLink({ path, label }: { path: string; label: string }) {
  const [message, setMessage] = useState("");
  const url = storefrontLink(path);
  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setMessage("Link copied.");
    } catch {
      setMessage("Open the link to copy it from the address bar.");
    }
  }
  return <div className="mt-2 flex flex-wrap items-center gap-2">
    <a href={url} className={secondary} target="_blank" rel="noreferrer">{label}</a>
    <button className={secondary} type="button" onClick={() => void copy()}>Copy link</button>
    {message && <span className="text-sm text-stone-600" role="status">{message}</span>}
  </div>;
}

function RefundDialog({ order, onClose, onRefund }: { order: DemoOrder; onClose: () => void; onRefund: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [mode, setMode] = useState<"full" | "partial">("full");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const balance = remaining(order);
  const refundAmount = mode === "full" ? balance : amount;
  const valid = /^\d{1,7}(\.\d{1,2})?$/.test(refundAmount) && Number(refundAmount) > 0 && Number(refundAmount) <= Number(balance);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !valid) return;
    setBusy(true);
    setError(undefined);
    try {
      await billingPost(`/api/demo/merchant/orders/${order.id}/refunds`, { amount: refundAmount, requestId });
      onRefund();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Refund could not be confirmed.");
      setBusy(false);
    }
  }

  return (
    <dialog ref={dialog} aria-labelledby="refund-title" className="w-[min(92vw,420px)] rounded-xl border border-stone-200 p-5 shadow-xl backdrop:bg-black/40" onClose={onClose} onCancel={(event) => { if (busy) event.preventDefault(); }}>
      <form onSubmit={submit} className="space-y-4">
        <div><h2 id="refund-title" className="text-lg font-semibold">Issue demo refund</h2><p className="text-sm text-stone-600">Return up to {balance} USDT to the original payer. No funds move in this demo.</p></div>
        <fieldset className="flex flex-wrap gap-3 text-sm" disabled={busy}>
          <legend className="sr-only">Refund type</legend>
          <label><input type="radio" name="refund-type" checked={mode === "full"} onChange={() => { setMode("full"); setRequestId(crypto.randomUUID()); }} /> Full remaining amount</label>
          <label><input type="radio" name="refund-type" checked={mode === "partial"} onChange={() => { setMode("partial"); setRequestId(crypto.randomUUID()); }} /> Partial</label>
        </fieldset>
        {mode === "partial" && <label className="block text-sm">Refund amount (USDT)<input className={field} inputMode="decimal" value={amount} onChange={(event) => { setAmount(event.target.value); setRequestId(crypto.randomUUID()); }} disabled={busy} /></label>}
        {error && <p className="text-sm text-red-700" role="alert">{error}</p>}
        <div className="flex flex-wrap gap-2">
          <button type="submit" disabled={!valid || busy} className={primary}>{busy ? "Recording refund…" : "Confirm refund"}</button>
          <button type="button" disabled={busy} className={secondary} onClick={() => dialog.current?.close()}>Cancel</button>
        </div>
      </form>
    </dialog>
  );
}

export function BillingWorkspace({ onRefundRecorded }: { onRefundRecorded?: () => void }) {
  const [active, setActive] = useState<(typeof tabs)[number]>("Refunds");
  const [orders, setOrders] = useState<DemoOrder[]>([]);
  const [invoices, setInvoices] = useState<DemoInvoice[]>([]);
  const [plans, setPlans] = useState<DemoPlan[]>([]);
  const [subscriptions, setSubscriptions] = useState<DemoSubscription[]>([]);
  const [refund, setRefund] = useState<DemoOrder>();
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState<string>();
  const [requestKind, setRequestKind] = useState<DemoInvoice["kind"]>("invoice");

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(undefined);
    try {
      const [o, i, p, s] = await Promise.all([
        billingRequest<{ orders: DemoOrder[] }>("/api/demo/merchant/orders", { signal }),
        billingRequest<{ invoices: DemoInvoice[] }>("/api/demo/merchant/invoices", { signal }),
        billingRequest<{ plans: DemoPlan[] }>("/api/demo/merchant/plans", { signal }),
        billingRequest<{ subscriptions: DemoSubscription[] }>("/api/demo/merchant/subscriptions", { signal }),
      ]);
      if (signal?.aborted) return;
      setOrders(o.orders);
      setInvoices(i.invoices);
      setPlans(p.plans);
      setSubscriptions(s.subscriptions);
    } catch (cause) {
      if (!signal?.aborted) setError(cause instanceof Error ? cause.message : "Could not load demo billing.");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function create(event: FormEvent<HTMLFormElement>, kind: "invoices" | "plans") {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(undefined);
    setStatus(undefined);
    const form = event.currentTarget;
    const fields = Object.fromEntries(new FormData(form));
    try {
      if (kind === "invoices") {
        const invoice = await billingPost<DemoInvoice>("/api/demo/merchant/invoices", {
          ...fields, reminderDays: fields.reminderDays ? Number(fields.reminderDays) : null,
        });
        setInvoices((previous) => [invoice, ...previous]);
        setStatus(invoice.kind === "link" ? "Payment link created." : "Invoice created. Copy its payment link to share it.");
      } else {
        const plan = await billingPost<DemoPlan>("/api/demo/merchant/plans", fields);
        setPlans((previous) => [plan, ...previous]);
        setStatus("Plan created. Copy its signup link to share it.");
      }
      form.reset();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="billing-title" className="mb-6 rounded-lg border border-stone-200 bg-white p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h2 id="billing-title" className="font-semibold">Billing workspace</h2><p className="text-sm text-stone-600">Demo only. No funds move or emails are sent.</p></div>
        <button type="button" className={secondary} onClick={() => void load()} disabled={loading || busy}>Refresh billing</button>
      </div>
      <nav aria-label="Billing features" className="my-4 flex flex-wrap gap-2">
        {tabs.map((tab) => <button key={tab} type="button" aria-pressed={active === tab} className={active === tab ? primary : secondary}
          onClick={() => { setActive(tab); setStatus(undefined); }} disabled={busy}>{tab}</button>)}
      </nav>
      {error && <p role="alert" className="mb-3 text-sm text-red-700">{error}</p>}
      {status && <p role="status" className="mb-3 text-sm text-emerald-800">{status}</p>}
      {loading && <p role="status" className="mb-3 text-sm text-stone-600">Loading billing…</p>}

      {active === "Refunds" && (
        <div>
          <h3 className="font-medium">Completed demo payments</h3>
          {!orders.length && !loading && <p className="mt-2 text-sm text-stone-600">Complete a demo purchase, then refresh billing to issue a refund.</p>}
          <ul className="mt-2 divide-y divide-stone-200">
            {orders.map((order) => <li key={order.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
              <div><strong>{order.amount} USDT</strong><p className="text-stone-600">{remaining(order)} USDT refundable · {order.refunds.length} {order.refunds.length === 1 ? "refund" : "refunds"}</p></div>
              <div className="flex flex-wrap gap-2">
                <a className={secondary} href={storefrontLink(`/success/${order.id}?details=1`)} target="_blank" rel="noreferrer">Customer receipt</a>
                <button type="button" className={primary} disabled={Number(remaining(order)) <= 0} onClick={() => setRefund(order)}>Refund</button>
              </div>
            </li>)}
          </ul>
          {refund && <RefundDialog order={refund} onClose={() => setRefund(undefined)} onRefund={() => {
            setRefund(undefined);
            setStatus("Demo refund recorded. Reopen the customer receipt to see it.");
            void load();
            onRefundRecorded?.();
          }} />}
        </div>
      )}

      {active === "Invoices & links" && (
        <>
          <h3 className="font-medium">Request a payment</h3>
          <form onSubmit={(event) => void create(event, "invoices")} className="my-3 grid gap-3 text-sm sm:grid-cols-2">
            <label>Request type<select name="kind" className={field} value={requestKind} onChange={(event) => setRequestKind(event.target.value === "link" ? "link" : "invoice")}><option value="invoice">Invoice</option><option value="link">Payment link</option></select></label>
            <label>Service or line item<input name="description" className={field} required maxLength={240} /></label>
            <label>Amount (USDT)<input name="amount" className={field} inputMode="decimal" required /></label>
            {requestKind === "invoice" && <>
              <label>Client<input name="client" className={field} required maxLength={120} /></label>
              <label>Due date (UTC)<input name="dueDate" type="date" className={field} required /></label>
              <label>Reminder before due date<select name="reminderDays" className={field}><option value="">None</option><option value="1">1 day</option><option value="3">3 days</option><option value="7">7 days</option></select></label>
            </>}
            <div className="self-end"><button className={primary} disabled={busy}>{requestKind === "link" ? "Create payment link" : "Create invoice"}</button></div>
          </form>
          <ul className="divide-y divide-stone-200">
            {invoices.map((invoice) => <li key={invoice.id} className="py-3 text-sm">
              <strong>{invoice.description} · {invoice.amount} USDT</strong>
              <p className="text-stone-600">{invoice.kind === "link" ? "Payment link" : `${invoice.client} · Due ${invoice.dueDate}`} · {invoiceStatus(invoice)}</p>
              {invoice.reminderDays && invoiceStatus(invoice) === "Unpaid" && <p className="text-stone-600">Demo reminder set {invoice.reminderDays} {invoice.reminderDays === 1 ? "day" : "days"} before the due date.</p>}
              <ShareLink path={`/invoice/${invoice.id}`} label="Open payment link" />
            </li>)}
          </ul>
        </>
      )}

      {active === "Subscriptions" && (
        <>
          <h3 className="font-medium">Create subscription plan</h3>
          <form onSubmit={(event) => void create(event, "plans")} className="my-3 grid gap-3 text-sm sm:grid-cols-2">
            <label>Plan name<input name="name" className={field} required maxLength={120} /></label>
            <label>Amount per charge (USDT)<input name="amount" className={field} inputMode="decimal" required /></label>
            <label>Billing interval<select name="interval" className={field}><option value="month">Monthly</option><option value="year">Yearly</option></select></label>
            <div className="self-end"><button className={primary} disabled={busy}>Create plan</button></div>
          </form>
          <ul className="divide-y divide-stone-200">
            {plans.map((plan) => <li key={plan.id} className="py-3 text-sm"><strong>{plan.name} · {plan.amount} USDT / {plan.interval}</strong><ShareLink path={`/subscribe/${plan.id}`} label="Open signup link" /></li>)}
          </ul>
          {!!subscriptions.length && <div className="mt-4"><h3 className="font-medium">Demo subscriptions</h3><ul className="mt-2 space-y-1 text-sm">
            {subscriptions.map((subscription) => <li key={subscription.id}>{subscription.plan.name} · {subscription.status === "active" ? "Active" : "Cancelled"}</li>)}
          </ul></div>}
        </>
      )}
    </section>
  );
}
