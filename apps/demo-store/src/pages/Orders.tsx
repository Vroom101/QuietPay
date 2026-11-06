import { Link } from "react-router-dom";
import { listOrders } from "../orders";

export function Orders() {
  const orders = listOrders();

  return (
    <section className="store-orders">
      <h1>Your orders</h1>
      <p>Orders placed from this browser.</p>
      {orders.length ? (
        <ul className="store-order-list">
          {orders.map(({ paymentId, summary }) => (
            <li className="store-order" key={paymentId}>
              <div className="store-order-heading">
                <div><strong>Order QP-{paymentId.slice(-8).toUpperCase()}</strong>
                  {summary && <small>{new Date(summary.placedAt).toLocaleDateString()}</small>}
                </div>
                {summary && <strong>{summary.total} USDT</strong>}
              </div>
              {summary ? (
                <ul className="store-order-items" aria-label="Items ordered">
                  {summary.items.map(({ name, quantity }) => <li key={name}><span>{name}</span><span>Qty {quantity}</span></li>)}
                </ul>
              ) : <p>Item details are unavailable for this earlier order.</p>}
              <Link to={`/success/${encodeURIComponent(paymentId)}?details=1`}>View payment details</Link>
            </li>
          ))}
        </ul>
      ) : <p className="store-orders-empty">No orders yet.</p>}
    </section>
  );
}
