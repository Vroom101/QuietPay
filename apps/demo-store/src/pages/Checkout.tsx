import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { QuietpayCheckout } from "@quietpay/widget/react";
import { parseUsdt } from "@quietpay/shared";
import { FIXTURE_ROUTER } from "@quietpay/shared/fixtures";
import { useCart } from "../cart";
import { PRODUCTS, cents, fromCents } from "../products";
import { Icon } from "../Icon";
import { ProductImage } from "../ProductImage";
import { directPayment, type DemoQuote, type PaymentMethod } from "../payment";
import { rememberOrder } from "../orders";

const MOCK_RELAYER_URL = "http://localhost:8787";
const RELAYER_URL = import.meta.env.VITE_RELAYER_URL || MOCK_RELAYER_URL;
const IS_DEMO = RELAYER_URL === MOCK_RELAYER_URL;
const EXPECTED_ROUTER = import.meta.env.VITE_CHECKOUT_ROUTER ||
  (RELAYER_URL === MOCK_RELAYER_URL ? FIXTURE_ROUTER : undefined);

async function post<T>(path: string, body: object): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => undefined);
    throw new Error(detail?.error || "Checkout is unavailable. Please try again.");
  }
  return response.json() as Promise<T>;
}

export function Checkout() {
  const { items, total, clear, count } = useCart();
  const nav = useNavigate();
  const [methods, setMethods] = useState<PaymentMethod[]>([directPayment]);
  const [method, setMethod] = useState(directPayment);
  const [destination, setDestination] = useState(directPayment);
  const simulated = method.simulated || destination.simulated;
  const [quote, setQuote] = useState<DemoQuote>();
  const [expired, setExpired] = useState(false);
  const [orderId, setOrderId] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/checkout/methods", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return;
        const data = (await response.json()) as { methods: PaymentMethod[] };
        if (!controller.signal.aborted) setMethods(data.methods);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  useEffect(() => {
    setQuote(undefined);
    setOrderId(undefined);
    setError(undefined);
  }, [items]);

  useEffect(() => {
    setExpired(false);
    if (!quote) return;
    const timer = setTimeout(() => setExpired(true), Math.max(0, quote.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [quote]);

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
    const cart = { items, cartTotal: total };
    try {
      if (!simulated) {
        const order = await post<{ orderId: string }>("/api/checkout", cart);
        setOrderId(order.orderId);
      } else if (!quote || expired || quote.expiresAt <= Date.now()) {
        setQuote(await post<DemoQuote>("/api/checkout/demo-quote", { ...cart, methodId: method.id, destinationId: destination.id }));
      } else {
        const order = await post<{ orderId: string }>("/api/checkout/demo-confirm", { quoteId: quote.id });
        finish(order.orderId);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Checkout is unavailable. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!count) {
    return <section className="gateway gateway-empty"><h1>Your cart is empty</h1><Link className="gateway-primary" to="/cart">View cart <Icon name="arrow" /></Link></section>;
  }

  return (
    <section className="gateway gateway-checkout">
      <div className="gateway-top">
        <Link to="/cart" className="gateway-back"><Icon name="left" /> Back to cart</Link>
        <span className="gateway-mode"><span /> {IS_DEMO ? "Demo checkout" : "Stablecoin checkout"}</span>
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
            <p className="gateway-card-merchant"><Icon name="store" /> Quiet Store · {count} {count === 1 ? "item" : "items"}</p>
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
            <h2>{orderId || quote ? "Review payment" : "Pay with stablecoin"}</h2>
            <span>{IS_DEMO ? "Preview" : "Checkout"}</span>
          </div>
          {!orderId && (
            <fieldset className="gateway-console-fields" disabled={busy}>
              <legend className="sr-only">Payment route</legend>
              <label className="gateway-route">
                <span><strong>Pay from</strong><small>What you send</small></span>
                <select aria-label="Pay from" value={method.id} onChange={(event) => {
                  setMethod(methods.find((option) => option.id === event.target.value) ?? directPayment);
                  setQuote(undefined);
                  setError(undefined);
                }}>
                  {methods.map((option) => <option key={option.id} value={option.id}>{option.simulated ? "Stablecoin (demo)" : option.symbol}</option>)}
                  <option disabled>Other crypto (unavailable)</option>
                </select>
              </label>
              <label className="gateway-route">
                <span><strong>To</strong><small>What the merchant receives</small></span>
                <select aria-label="To" value={destination.id} onChange={(event) => {
                  setDestination(methods.find((option) => option.id === event.target.value) ?? directPayment);
                  setQuote(undefined);
                  setError(undefined);
                }}>
                  {methods.map((option) => <option key={option.id} value={option.id}>{option.simulated ? "Stablecoin (demo)" : option.symbol}</option>)}
                </select>
              </label>
            </fieldset>
          )}
          {quote && (
            <div className="gateway-quote">
              <dl>
                <div><dt>You pay</dt><dd>{quote.payAmount} {quote.symbol}</dd></div>
                <div><dt>Merchant receives</dt><dd>{quote.merchantAmount} {quote.settlementSymbol}</dd></div>
                <div><dt>Merchant relay fee</dt><dd>{quote.relayFee} {quote.settlementSymbol}</dd></div>
              </dl>
              <p role="status">{expired ? "Quote expired. Get a new quote to continue." : "Simulated quote · valid for 60 seconds from issue"}</p>
            </div>
          )}
          {orderId ? (
            <QuietpayCheckout
              orderId={orderId}
              relayerUrl={RELAYER_URL}
              expectedRouter={EXPECTED_ROUTER}
              expectedAmount={parseUsdt(total).toString()}
              expectedToken={import.meta.env.VITE_CHECKOUT_TOKEN || undefined}
              expectedDomainName={import.meta.env.VITE_CHECKOUT_DOMAIN_NAME || undefined}
              expectedDomainVersion={import.meta.env.VITE_CHECKOUT_DOMAIN_VERSION || undefined}
              onSettled={() => finish(orderId)}
            />
          ) : (
            <button type="button" onClick={() => void submit()} disabled={busy} className="gateway-primary">
              {busy ? "Working…" : quote && !expired ? `Confirm ${quote.payAmount} ${quote.symbol}` : expired ? "Refresh quote" : "Review payment details"}
              <Icon name="arrow" />
            </button>
          )}
          {error && <p role="alert" className="gateway-error">{error}</p>}
          <p className="gateway-fee-note"><span /> {simulated ? "Demo only. No funds will move." : "The merchant covers the relay fee."}</p>
        </div>
      </div>
    </section>
  );
}
