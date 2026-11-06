import { formatUsdt } from "@quietpay/shared";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

type PaymentStatus =
  | { paid: false }
  | { paid: true; amount: string; paidAt: number; txHash?: string };

export function Success() {
  const { orderId } = useParams();
  return orderId ? <Receipt key={orderId} orderId={orderId} /> : null;
}

function Receipt({ orderId }: { orderId: string }) {
  const [state, setState] = useState<PaymentStatus>({ paid: false });
  const [unavailable, setUnavailable] = useState(false);

  // The shop only marks an order paid once its server has verified the signed webhook.
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const response = await fetch(`/api/orders/${encodeURIComponent(orderId)}/paid`, { signal });
        if (!response.ok) throw new Error("Could not load payment status");
        const status = (await response.json()) as PaymentStatus;
        if (signal.aborted) return;
        setState(status);
        setUnavailable(false);
        if (!status.paid) retry = setTimeout(tick, 2000);
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

  return (
    <div className="rounded-lg bg-white p-6 text-center shadow-sm">
      <h2 className="text-2xl font-semibold">{state.paid ? "Payment receipt" : "Order status"}</h2>
      <p className="mt-2 text-sm text-stone-600" role="status" data-testid="shop-status">
        {state.paid && "The shop has confirmed your payment."}
        {unavailable && "We couldn't check your payment status. Trying again…"}
        {!state.paid && !unavailable && "The shop is confirming your payment…"}
      </p>
      <dl className="mx-auto mt-6 max-w-md space-y-3 rounded-lg bg-stone-50 p-4 text-left text-sm">
        <div>
          <dt className="font-medium">Order number</dt>
          <dd className="break-all text-stone-600">{orderId}</dd>
        </div>
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
                <dd className="break-all text-stone-600">{state.txHash}</dd>
              </div>
            )}
          </>
        )}
      </dl>
      <Link to="/" className="mt-6 inline-block underline">Keep shopping</Link>
    </div>
  );
}
