import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

interface Paid {
  paid: boolean;
  amount?: string;
  txHash?: string;
}

export function Success() {
  const { orderId } = useParams();
  const [state, setState] = useState<Paid>({ paid: false });

  // The shop only marks an order paid once its server has verified the signed webhook.
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const r = (await (await fetch(`/api/orders/${orderId}/paid`)).json()) as Paid;
        if (!stop) setState(r);
        if (!r.paid && !stop) setTimeout(tick, 2000);
      } catch {
        if (!stop) setTimeout(tick, 4000);
      }
    };
    void tick();
    return () => {
      stop = true;
    };
  }, [orderId]);

  return (
    <div className="rounded-lg bg-white p-6 text-center shadow-sm">
      <h2 className="text-2xl font-semibold">Thank you for your order</h2>
      <p className="mt-2 text-stone-600">Your payment went through.</p>
      <p className="mt-4 text-sm" data-testid="shop-status">
        {state.paid ? "The shop has confirmed your payment." : "The shop is confirming your payment..."}
      </p>
      <p className="mt-1 break-all text-xs text-stone-400">Order {orderId}</p>
      <Link to="/" className="mt-6 inline-block underline">Keep shopping</Link>
    </div>
  );
}
