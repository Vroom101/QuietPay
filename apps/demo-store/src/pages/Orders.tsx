import { formatUsdt } from "@quietpay/shared";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listOrderIds } from "../orders";
import { readPayment, type PaymentStatus } from "../payment";

function OrderEntry({ id }: { id: string }) {
  const [status, setStatus] = useState<PaymentStatus>();
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void readPayment(id, controller.signal).then(setStatus).catch(() => {
      if (!controller.signal.aborted) setUnavailable(true);
    });
    return () => controller.abort();
  }, [id]);
  const simulation = status?.paid === false ? status.simulation : undefined;
  const amount = status?.paid ? `${formatUsdt(status.amount)} USDT` : simulation ? `${simulation.quote.payAmount} ${simulation.quote.symbol}` : undefined;
  const label = simulation || (status?.paid && status.demo) ? "Demo complete" : status?.paid ? "Paid" : unavailable ? "Status unavailable" : status ? "Confirming" : "Checking status";
  return (
    <li>
      <div><strong>{amount ?? "Order"}</strong><small title={id}>{id.slice(0, 14)}…{id.slice(-5)}</small></div>
      <span>{label}</span>
      <Link to={`/success/${encodeURIComponent(id)}?details=1`}>Payment details</Link>
    </li>
  );
}

export function Orders() {
  const ids = listOrderIds();
  return (
    <section className="store-orders">
      <h1>Your orders</h1>
      <p>Payments completed from this browser appear here.</p>
      {ids.length ? <ul>{ids.map((id) => <OrderEntry key={id} id={id} />)}</ul> : <p className="store-orders-empty">No orders yet.</p>}
    </section>
  );
}
