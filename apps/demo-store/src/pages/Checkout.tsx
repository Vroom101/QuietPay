import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { QuietpayCheckout } from "@quietpay/widget/react";
import { parseUsdt } from "@quietpay/shared";
import { FIXTURE_ROUTER } from "@quietpay/shared/fixtures";
import { useCart } from "../cart";
import { PRODUCTS } from "../products";

const MOCK_RELAYER_URL = "http://localhost:8787";
const RELAYER_URL = import.meta.env.VITE_RELAYER_URL ?? MOCK_RELAYER_URL;
const EXPECTED_ROUTER = import.meta.env.VITE_CHECKOUT_ROUTER ||
  (RELAYER_URL === MOCK_RELAYER_URL ? FIXTURE_ROUTER : undefined);

export function Checkout() {
  const { items, total, remove, clear, count } = useCart();
  const nav = useNavigate();
  const [orderId, setOrderId] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  // Changing the cart invalidates any order we already created.
  useEffect(() => {
    setOrderId(undefined);
  }, [total]);

  async function start() {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items, cartTotal: total }),
      });
      if (res.status === 409) {
        setError("Your cart total has changed. Refresh the shop and try again.");
        return;
      }
      if (!res.ok) throw new Error("checkout failed");
      setOrderId(((await res.json()) as { orderId: string }).orderId);
    } catch {
      setError("We could not start your checkout. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (count === 0) {
    return <p>Your cart is empty. <Link className="underline" to="/">Back to the shop</Link></p>;
  }

  return (
    <div className="grid gap-8 sm:grid-cols-2">
      <div>
        <h2 className="mb-3 text-lg font-semibold">Your cart</h2>
        <ul className="space-y-2">
          {PRODUCTS.filter((p) => items[p.id]).map((p) => (
            <li key={p.id} className="flex items-center justify-between text-sm">
              <span>{items[p.id]} x {p.name}</span>
              <span>
                {p.price} USDT{" "}
                {!orderId && <button className="ml-2 text-stone-400" disabled={busy} onClick={() => remove(p.id)}>remove</button>}
              </span>
            </li>
          ))}
        </ul>
        <div className="mt-4 border-t pt-3 font-semibold">Total {total} USDT</div>
      </div>
      <div>
        <h2 className="mb-3 text-lg font-semibold">Payment</h2>
        {orderId ? (
          <QuietpayCheckout
            orderId={orderId}
            relayerUrl={RELAYER_URL}
            expectedRouter={EXPECTED_ROUTER}
            expectedAmount={parseUsdt(total).toString()}
            onSettled={() => {
              clear();
              nav(`/success/${orderId}`);
            }}
          />
        ) : (
          <>
            <button onClick={() => void start()} disabled={busy} className="rounded bg-stone-900 px-4 py-2 text-white disabled:opacity-50">
              {busy ? "Starting..." : `Pay ${total} USDT`}
            </button>
            {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
          </>
        )}
      </div>
    </div>
  );
}
