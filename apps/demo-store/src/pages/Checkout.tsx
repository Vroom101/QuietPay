import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { QuietpayCheckout } from "@quietpay/widget/react";
import { useCart } from "../cart";
import { PRODUCTS } from "../products";
import { parseCheckoutSession, type CheckoutSession } from "../checkout-session";

const RELAYER_URL = import.meta.env.VITE_RELAYER_URL ?? "http://localhost:8787";

export function Checkout() {
  const { items, total, remove, clear, count } = useCart();
  const nav = useNavigate();
  const [session, setSession] = useState<CheckoutSession>();
  const orderId = session?.orderId;
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  // Changing the cart invalidates any order we already created.
  useEffect(() => {
    setSession(undefined);
  }, [total]);

  async function start() {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Send only product ids and quantities; the server prices the cart from its own catalog.
        body: JSON.stringify({ items: Object.entries(items).map(([id, quantity]) => ({ id, quantity })) }),
      });
      if (!res.ok) throw new Error("checkout failed");
      setSession(parseCheckoutSession(await res.json()));
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
                {!orderId && <button className="ml-2 text-stone-400" onClick={() => remove(p.id)}>remove</button>}
              </span>
            </li>
          ))}
        </ul>
        <div className="mt-4 border-t pt-3 font-semibold">Total {total} USDT</div>
      </div>
      <div>
        <h2 className="mb-3 text-lg font-semibold">Payment</h2>
        {/* Amount and payout come from the store's own server; the widget refuses to sign anything else. */}
        {session ? (
          <QuietpayCheckout
            orderId={session.orderId}
            relayerUrl={RELAYER_URL}
            expectedAmount={session.amount}
            expectedPayout={session.payout}
            onSettled={() => {
              clear();
              nav(`/success/${session.orderId}`);
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
