import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { billingPost, billingRequest, invoiceStatus, type DemoInvoice, type DemoPlan, type DemoSubscription } from "../billing";
import { Checkout } from "./Checkout";

function useBillingResource<T>(path: string) {
  const [resource, setResource] = useState<{ path: string; data?: T; error?: string }>();
  useEffect(() => {
    const controller = new AbortController();
    void billingRequest<T>(path, { signal: controller.signal })
      .then((data) => { if (!controller.signal.aborted) setResource({ path, data }); })
      .catch((error: Error) => { if (!controller.signal.aborted) setResource({ path, error: error.message }); });
    return () => controller.abort();
  }, [path]);
  return resource?.path === path ? resource : undefined;
}

function BillingMessage({ title, message }: { title: string; message: string }) {
  return <section className="gateway gateway-receipt"><h1>{title}</h1><p role="status">{message}</p></section>;
}

export function InvoicePage({ checkout = false }: { checkout?: boolean }) {
  const { id } = useParams();
  const resource = useBillingResource<DemoInvoice>(`/api/demo/invoices/${encodeURIComponent(id ?? "")}`);
  const invoice = resource?.data;
  if (!invoice) return <BillingMessage title="Invoice" message={resource?.error ?? "Loading invoice…"} />;
  if (checkout && !invoice.paymentId) return <Checkout key={invoice.id} invoice={invoice} />;

  return (
    <section className="gateway gateway-receipt">
      <p className="gateway-kicker">QUIETPAY · {invoice.kind === "link" ? "DEMO PAYMENT LINK" : "DEMO INVOICE"}</p>
      <h1>{invoice.amount} USDT</h1>
      <p className="gateway-receipt-status">{invoice.description}</p>
      <dl className="gateway-receipt-details">
        {invoice.client && <div><dt>Billed to</dt><dd>{invoice.client}</dd></div>}
        {invoice.dueDate && <div><dt>Due date</dt><dd>{invoice.dueDate}</dd></div>}
        <div><dt>Status</dt><dd>{invoiceStatus(invoice)}</dd></div>
      </dl>
      {invoice.paymentId
        ? <Link className="gateway-primary" to={`/success/${invoice.paymentId}?details=1`}>View payment details</Link>
        : <Link className="gateway-primary" to={`/checkout/invoice/${invoice.id}`}>{invoice.kind === "link" ? "Continue to checkout" : "Pay invoice"}</Link>}
    </section>
  );
}

export function SubscribePage() {
  const { id } = useParams();
  return <Subscribe key={id} id={id ?? ""} />;
}

function Subscribe({ id }: { id: string }) {
  const resource = useBillingResource<DemoPlan>(`/api/demo/plans/${encodeURIComponent(id)}`);
  const plan = resource?.data;
  const [consent, setConsent] = useState(false);
  const [requestId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const navigate = useNavigate();

  async function activate() {
    if (busy || !consent || !plan) return;
    setBusy(true);
    setError(undefined);
    try {
      const subscription = await billingPost<DemoSubscription>(`/api/demo/plans/${plan.id}/subscribe`, { consent, requestId });
      navigate(`/subscription/${subscription.id}`, { replace: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start the subscription.");
      setBusy(false);
    }
  }

  if (!plan) return <BillingMessage title="Subscription" message={resource?.error ?? "Loading plan…"} />;
  return (
    <section className="gateway gateway-receipt">
      <p className="gateway-kicker">QUIETPAY · DEMO SUBSCRIPTION</p>
      <h1>{plan.name}</h1>
      <dl className="gateway-receipt-details">
        <div><dt>Recurring amount</dt><dd>{plan.amount} USDT / {plan.interval}</dd></div>
        <div><dt>First scheduled charge</dt><dd>In one {plan.interval}</dd></div>
        <div><dt>Cancellation</dt><dd>Cancel anytime</dd></div>
      </dl>
      <p className="gateway-receipt-status">This is a simulation. No spending permission is requested and no funds will move.</p>
      <label className="mb-4 flex items-center justify-center gap-2 text-sm"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} disabled={busy} /> I agree to the recurring terms</label>
      <button className="gateway-primary" disabled={!consent || busy} onClick={() => void activate()}>{busy ? "Starting…" : "Start demo subscription"}</button>
      {error && <p role="alert" className="gateway-error">{error}</p>}
    </section>
  );
}

export function SubscriptionPage() {
  const { id } = useParams();
  return <Subscription key={id} id={id ?? ""} />;
}

function Subscription({ id }: { id: string }) {
  const resource = useBillingResource<DemoSubscription>(`/api/demo/subscriptions/${encodeURIComponent(id)}`);
  const [updated, setUpdated] = useState<DemoSubscription>();
  const subscription = updated ?? resource?.data;
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function cancel() {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      setUpdated(await billingPost<DemoSubscription>(`/api/demo/subscriptions/${encodeURIComponent(id)}/cancel`));
      setConfirm(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not cancel the subscription.");
    } finally {
      setBusy(false);
    }
  }

  if (!subscription) return <BillingMessage title="Subscription" message={resource?.error ?? "Loading subscription…"} />;
  return (
    <section className="gateway gateway-receipt">
      <p className="gateway-kicker">QUIETPAY · DEMO SUBSCRIPTION</p>
      <h1>{subscription.plan.name}</h1>
      <dl className="gateway-receipt-details">
        <div><dt>Status</dt><dd role="status">{subscription.status === "active" ? "Active" : "Cancelled"}</dd></div>
        <div><dt>Recurring amount</dt><dd>{subscription.plan.amount} USDT / {subscription.plan.interval}</dd></div>
        <div><dt>Next scheduled charge</dt><dd>{subscription.nextCharge ? new Date(subscription.nextCharge).toLocaleDateString() : "None"}</dd></div>
      </dl>
      <p className="gateway-receipt-status">{subscription.status === "active" ? "No charges yet. This demo does not execute renewals." : "Future charges have been disabled for this demo subscription."}</p>
      {subscription.status === "active" && (confirm ? (
        <div className="payment-receipt-actions">
          <button className="gateway-primary" onClick={() => void cancel()} disabled={busy}>Confirm cancellation</button>
          <button className="gateway-primary payment-secondary" onClick={() => setConfirm(false)} disabled={busy}>Keep subscription</button>
        </div>
      ) : <button className="gateway-primary payment-secondary" onClick={() => setConfirm(true)}>Cancel subscription</button>)}
      {error && <p role="alert" className="gateway-error">{error}</p>}
    </section>
  );
}
