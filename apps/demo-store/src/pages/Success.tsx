import { formatUsdt } from "@quietpay/shared";
import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { readPayment, type PaymentStatus } from "../payment";

export function Success() {
  const { orderId } = useParams();
  return orderId ? <Receipt key={orderId} orderId={orderId} /> : null;
}

function Receipt({ orderId }: { orderId: string }) {
  const [state, setState] = useState<PaymentStatus>({ paid: false });
  const [unavailable, setUnavailable] = useState(false);
  const [details, setDetails] = useSearchParams();

  // The shop only marks an order paid once its server has verified the signed webhook.
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const startedAt = Date.now();
    const tick = async () => {
      try {
        const status = await readPayment(orderId, signal);
        if (signal.aborted) return;
        setUnavailable(false);
        if (status.paid || status.simulation) {
          retry = setTimeout(() => setState(status), Math.max(0, 450 - (Date.now() - startedAt)));
        } else {
          retry = setTimeout(tick, 2000);
        }
      } catch {
        if (signal.aborted) return;
        setUnavailable(true);
        retry = setTimeout(tick, 4000);
      }
    };
    void tick();
    return () => {
      controller.abort();
      clearTimeout(retry);
    };
  }, [orderId]);

  const simulation = state.paid ? undefined : state.simulation;
  const complete = state.paid || !!simulation;
  const showDetails = details.get("details") === "1";
  return (
    <div className="gateway gateway-receipt">
      <p className="gateway-kicker">QUIETPAY CHECKOUT</p>
      <div className={`payment-indicator ${complete ? "payment-indicator-done" : ""}`} aria-hidden="true">
        {complete ? <svg viewBox="0 0 32 32" fill="none"><path d="m7 16 6 6L25 10" /></svg> : <span />}
      </div>
      <h1>{simulation ? "Demo receipt" : state.paid ? "Payment receipt" : "Processing payment"}</h1>
      <p className="gateway-receipt-status" role="status" data-testid="shop-status">
        {simulation && "Simulated conversion complete. No funds moved."}
        {state.paid && (state.demo ? "Demo payment confirmed. No funds moved." : "The shop has confirmed your payment.")}
        {unavailable && "We couldn't check your payment status. Trying again…"}
        {!state.paid && !simulation && !unavailable && "The shop is confirming your payment…"}
      </p>
      {complete && showDetails && <dl id="payment-details" className="gateway-receipt-details">
        <div>
          <dt className="font-medium">Order number</dt>
          <dd className="break-all">{orderId}</dd>
        </div>
        {simulation && <>
          <div><dt>You paid (simulated)</dt><dd>{simulation.quote.payAmount} {simulation.quote.symbol}</dd></div>
          <div><dt>Merchant payout (simulated)</dt><dd>{simulation.quote.merchantAmount} {simulation.quote.settlementSymbol}</dd></div>
          <div><dt>Merchant relay fee</dt><dd>{simulation.quote.relayFee} {simulation.quote.settlementSymbol}</dd></div>
          <div><dt>Completed at</dt><dd>{new Date(simulation.confirmedAt * 1000).toLocaleString()}</dd></div>
        </>}
        {state.paid && (
          <>
            <div>
              <dt className="font-medium">Amount paid</dt>
              <dd>{formatUsdt(state.amount)}</dd>
            </div>
            <div>
              <dt className="font-medium">Confirmed at</dt>
              <dd>{new Date(state.paidAt * 1000).toLocaleString()}</dd>
            </div>
            {state.txHash && (
              <div>
                <dt className="font-medium">Payment reference</dt>
                <dd className="break-all">{state.txHash}</dd>
              </div>
            )}
          </>
        )}
      </dl>}
      {complete && <div className="payment-receipt-actions">
        <button type="button" className="gateway-primary" aria-expanded={showDetails} onClick={() => setDetails(showDetails ? {} : { details: "1" }, { replace: true })}>{showDetails ? "Hide payment details" : "View payment details"}</button>
        <Link to="/orders" className="gateway-primary payment-secondary">View orders</Link>
      </div>}
    </div>
  );
}
