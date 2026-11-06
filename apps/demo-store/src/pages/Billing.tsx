import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { QuietpayCheckout } from "@quietpay/widget/react";
import { billingRequest, invoiceStatus, type DemoInvoice } from "../billing";
import { Checkout } from "./Checkout";
import type { CheckoutSession } from "../checkout-session";
import {
  cancelSubscription, getPlan, getSubscription, intervalLabel, renew, subscribe,
  type PlanView, type SubscriptionView,
} from "../subscriptions";

const RELAYER_URL = import.meta.env.VITE_RELAYER_URL || "http://localhost:8787";
const POLL_MS = 2000;
const POLL_MAX_MS = 30_000;

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
  const [plan, setPlan] = useState<PlanView>();
  const [loadError, setLoadError] = useState<string>();
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [started, setStarted] = useState<{ subscriptionId: string; checkout: CheckoutSession }>();
  const navigate = useNavigate();

  useEffect(() => {
    const controller = new AbortController();
    getPlan(id, controller.signal)
      .then((loaded) => { if (!controller.signal.aborted) setPlan(loaded); })
      .catch((cause: Error) => { if (!controller.signal.aborted) setLoadError(cause.message); });
    return () => controller.abort();
  }, [id]);

  async function activate() {
    if (busy || !consent || !plan) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await subscribe(plan.id);
      setStarted({ subscriptionId: result.subscription.id, checkout: result.checkout });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start the subscription.");
      setBusy(false);
    }
  }

  if (!plan) return <BillingMessage title="Subscription" message={loadError ?? "Loading plan…"} />;
  const every = intervalLabel(plan);
  return (
    <section className="gateway gateway-receipt">
      <p className="gateway-kicker">QUIETPAY · SUBSCRIPTION</p>
      <h1>{plan.name}</h1>
      <dl className="gateway-receipt-details">
        <div><dt>Recurring amount</dt><dd>{plan.amount} USDT {every}</dd></div>
        <div><dt>Cancellation</dt><dd>Cancel anytime</dd></div>
      </dl>
      {started ? (
        <>
          <p className="gateway-receipt-status">Sign to pay your first period.</p>
          <QuietpayCheckout
            orderId={started.checkout.orderId}
            relayerUrl={RELAYER_URL}
            expectedAmount={started.checkout.amount}
            expectedPayout={started.checkout.payout}
            onSettled={() => navigate(`/subscription/${encodeURIComponent(started.subscriptionId)}`, { replace: true, state: { justPaidFrom: 0 } })}
          />
        </>
      ) : (
        <>
          <label className="mb-4 flex items-center justify-center gap-2 text-sm">
            <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} disabled={busy} />
            I agree to pay {plan.amount} USDT {every}. Each payment needs my signature; nothing is taken automatically.
          </label>
          <button className="gateway-primary" disabled={!consent || busy} onClick={() => void activate()}>{busy ? "Starting…" : "Subscribe and pay first period"}</button>
        </>
      )}
      {error && <p role="alert" className="gateway-error">{error}</p>}
    </section>
  );
}

export function SubscriptionPage() {
  const { id } = useParams();
  return <Subscription key={id} id={id ?? ""} />;
}

const STATUS_LABEL = { active: "Active", past_due: "Payment due", cancelled: "Cancelled" } as const;

function Subscription({ id }: { id: string }) {
  // Arriving straight from paying the first period: confirm it (the webhook can lag a few seconds) instead of
  // showing "Pay now" for a period that is already paid.
  const arrived = (useLocation().state as { justPaidFrom?: unknown } | null)?.justPaidFrom;
  const [subscription, setSubscription] = useState<SubscriptionView>();
  const [loadError, setLoadError] = useState<string>();
  const [checkout, setCheckout] = useState<CheckoutSession>();
  const [waitingFrom, setWaitingFrom] = useState<number | undefined>(typeof arrived === "number" ? arrived : undefined);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();
    getSubscription(id, controller.signal)
      .then((loaded) => { if (!controller.signal.aborted) setSubscription(loaded); })
      .catch((cause: Error) => { if (!controller.signal.aborted) setLoadError(cause.message); });
    return () => controller.abort();
  }, [id]);

  // After the widget settles, the webhook may take a few seconds: poll until a new period shows as paid.
  useEffect(() => {
    if (waitingFrom === undefined) return;
    let stopped = false;
    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const latest = await getSubscription(id);
        if (stopped) return;
        setSubscription(latest);
        if (latest.paidPeriods > waitingFrom) { setWaitingFrom(undefined); setCheckout(undefined); return; }
      } catch { /* keep trying until the deadline */ }
      if (stopped) return;
      if (Date.now() - startedAt >= POLL_MAX_MS) {
        setWaitingFrom(undefined);
        setCheckout(undefined);
        setError("Your payment is still being confirmed. Refresh this page in a moment.");
        return;
      }
      timer = setTimeout(() => void tick(), POLL_MS);
    };
    timer = setTimeout(() => void tick(), POLL_MS);
    return () => { stopped = true; clearTimeout(timer); };
  }, [id, waitingFrom]);

  async function payNow() {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await renew(id);
      setSubscription(result.subscription);
      setCheckout(result.checkout);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start the payment.");
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      setSubscription(await cancelSubscription(id));
      setCheckout(undefined);
      setConfirm(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not cancel the subscription.");
    } finally {
      setBusy(false);
    }
  }

  if (!subscription) return <BillingMessage title="Subscription" message={loadError ?? "Loading subscription…"} />;
  const cancelled = subscription.status === "cancelled";
  const payable = !cancelled && (subscription.due || Boolean(subscription.pendingOrderId) || checkout !== undefined);
  const waiting = waitingFrom !== undefined;
  return (
    <section className="gateway gateway-receipt">
      <p className="gateway-kicker">QUIETPAY · SUBSCRIPTION</p>
      <h1>{subscription.plan.name}</h1>
      <dl className="gateway-receipt-details">
        <div><dt>Status</dt><dd role="status">{STATUS_LABEL[subscription.status]}</dd></div>
        <div><dt>Plan</dt><dd>{subscription.plan.amount} USDT {intervalLabel(subscription.plan)}</dd></div>
        <div><dt>Periods paid</dt><dd>{subscription.paidPeriods}</dd></div>
        <div><dt>Next payment</dt><dd>{!cancelled && subscription.nextCharge ? new Date(subscription.nextCharge).toLocaleDateString() : "None"}</dd></div>
      </dl>
      {subscription.lastPaidOrderId && <p><Link to={`/success/${subscription.lastPaidOrderId}`}>View last receipt</Link></p>}
      <p className="gateway-receipt-status">
        {cancelled
          ? "This subscription is cancelled. You will not be asked to pay again."
          : "Each payment needs your signature; nothing is taken automatically."}
      </p>
      {waiting && <p role="status" className="gateway-receipt-status">Confirming your payment…</p>}
      {payable && checkout && !waiting && (
        <QuietpayCheckout
          orderId={checkout.orderId}
          relayerUrl={RELAYER_URL}
          expectedAmount={checkout.amount}
          expectedPayout={checkout.payout}
          onSettled={() => setWaitingFrom(subscription.paidPeriods)}
        />
      )}
      {payable && !checkout && !waiting && (
        <button className="gateway-primary" disabled={busy} onClick={() => void payNow()}>{busy ? "Working…" : `Pay ${subscription.plan.amount} USDT now`}</button>
      )}
      {!cancelled && !waiting && (confirm ? (
        <div className="payment-receipt-actions">
          <button className="gateway-primary" onClick={() => void cancel()} disabled={busy}>Confirm cancellation</button>
          <button className="gateway-primary payment-secondary" onClick={() => setConfirm(false)} disabled={busy}>Keep subscription</button>
        </div>
      ) : <button className="gateway-primary payment-secondary" onClick={() => setConfirm(true)}>Cancel subscription</button>)}
      {error && <p role="alert" className="gateway-error">{error}</p>}
    </section>
  );
}
