import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { QuietpayCheckout } from "@quietpay/widget/react";
import { ORDER_TOKEN_HEADER } from "@quietpay/shared";
import { useCart } from "../cart";
import { PRODUCTS, cents, fromCents } from "../products";
import { Icon } from "../Icon";
import { ProductImage } from "../ProductImage";
import { parseCheckoutSession, type CheckoutSession } from "../checkout-session";
import { rememberToken } from "../order-token";
import { rememberOrder } from "../orders";
import type { DemoInvoice } from "../billing";

const RELAYER_URL = import.meta.env.VITE_RELAYER_URL || "http://localhost:8787";

export function Checkout({ invoice }: { invoice?: DemoInvoice }) {
  const cart = useCart();
  const { items, clear } = cart;
  const total = cart.total;
  const count = cart.count;
  const nav = useNavigate();
  const [session, setSession] = useState<CheckoutSession>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  // A changed cart invalidates any order that was already started for the old cart.
  useEffect(() => {
    setSession(undefined);
    setError(undefined);
  }, [items]);

  function finish(id: string) {
    rememberOrder(id, {
      total,
      placedAt: Date.now(),
      items: PRODUCTS.flatMap((product) => items[product.id] ? [{ name: product.name, quantity: items[product.id]! }] : []),
    });
    clear();
    nav(`/success/${id}`, { replace: true });
  }

  async function submit() {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      // SECURITY: send only product ids and quantities. The store's server prices the cart from its own catalog,
      // creates the order, and tells us the exact amount and payout the widget must pin before it signs anything.
      const response = await fetch("/api/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items: Object.entries(items).map(([id, quantity]) => ({ id, quantity })) }),
      });
      if (!response.ok) {
        const detail = await response.json().catch(() => undefined);
        throw new Error(detail?.error || "Checkout is unavailable. Please try again.");
      }
      const started = parseCheckoutSession(await response.json());
      // The customer's status token comes back once, in a header. Keep it for this browser tab only.
      const token = response.headers.get(ORDER_TOKEN_HEADER);
      if (token) rememberToken(started.orderId, token);
      setSession(started);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "We could not start your checkout. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (invoice) {
    return <section className="gateway gateway-empty"><h1>Invoice payments are a demo feature</h1><p>They are not available on the live checkout.</p><Link className="gateway-primary" to="/cart">Back to cart <Icon name="arrow" /></Link></section>;
  }

  if (!count) {
    return <section className="gateway gateway-empty"><h1>Your cart is empty</h1><Link className="gateway-primary" to="/cart">View cart <Icon name="arrow" /></Link></section>;
  }

  return (
    <section className="gateway gateway-checkout">
      <div className="gateway-top">
        <Link to="/cart" className="gateway-back"><Icon name="left" /> Back to cart</Link>
        <span className="gateway-mode"><span /> Stablecoin checkout</span>
      </div>
      <div className="gateway-intro">
        <h1>Checkout</h1>
      </div>
      <div className="gateway-grid">
        <aside className="gateway-summary" aria-labelledby="summary-title">
          <div className="gateway-total">
            <svg className="gateway-card-curves" viewBox="0 0 500 300" preserveAspectRatio="none" fill="none" aria-hidden="true">
              <path d="M506 20C462 84 397 120 281 131" />
              <path d="M508 163C412 180 322 213 211 304" />
              <path d="M510 165C427 181 348 219 270 304" />
            </svg>
            <img className="gateway-card-logo" src="/brand/quietpay-wordmark.png" alt="QuietPay" />
            <p id="summary-title" className="gateway-total-label">Order total</p>
            <div className={`gateway-card-amount${total.length > 8 ? " gateway-card-amount-long" : ""}`}>
              <strong>{total}</strong><span>USDT</span>
            </div>
            <p className="gateway-card-merchant"><Icon name="store" /> {`Quiet Store · ${count} ${count === 1 ? "item" : "items"}`}</p>
          </div>
          <div className="gateway-items">
            <h2>Order summary</h2>
            <ul>
              {PRODUCTS.filter((product) => items[product.id]).map((product) => (
                <li key={product.id}>
                  <ProductImage product={product} className="gateway-item-image" />
                  <div className="gateway-item-label"><strong>{product.name}</strong><small>Qty {items[product.id]} · {product.price} USDT each</small></div>
                  <span className="gateway-line-price">{fromCents(cents(product.price) * items[product.id]!)} USDT</span>
                </li>
              ))}
            </ul>
          </div>
        </aside>
        <div className="gateway-payment">
          <div className="gateway-console-heading">
            <h2>{session ? "Review payment" : "Pay with stablecoin"}</h2>
            <span>Checkout</span>
          </div>
          {!session && (
            <div className="gateway-quote">
              <dl>
                <div><dt>Merchant receives</dt><dd>USDT</dd></div>
                <div><dt>Relay fee</dt><dd>Covered by the merchant</dd></div>
              </dl>
            </div>
          )}
          {session ? (
            // Amount and payout come from the store's own server; the widget refuses to sign anything else.
            <QuietpayCheckout
              orderId={session.orderId}
              relayerUrl={RELAYER_URL}
              expectedAmount={session.amount}
              expectedPayout={session.payout}
              onSettled={() => finish(session.orderId)}
            />
          ) : (
            <button type="button" onClick={() => void submit()} disabled={busy} className="gateway-primary">
              {busy ? "Working…" : "Review payment details"}
              <Icon name="arrow" />
            </button>
          )}
          {error && <p role="alert" className="gateway-error">{error}</p>}
        </div>
      </div>
    </section>
  );
}
