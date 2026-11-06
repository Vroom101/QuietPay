import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { QuietpayCheckout } from "@quietpay/widget/react";
import { parseUsdt } from "@quietpay/shared";
import { FIXTURE_ROUTER } from "@quietpay/shared/fixtures";
import { useCart } from "../cart";
import { PRODUCTS, cents, fromCents } from "../products";
import { Icon } from "../Icon";
import { ProductImage } from "../ProductImage";
import { directPayment, previewUsdtCents, type DemoQuote, type PaymentMethod } from "../payment";
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
  const { items, total, add, remove, clear, count } = useCart();
  const nav = useNavigate();
  const [methods, setMethods] = useState<PaymentMethod[]>([directPayment]);
  const [method, setMethod] = useState(directPayment);
  const [quote, setQuote] = useState<DemoQuote>();
  const [expired, setExpired] = useState(false);
  const [orderId, setOrderId] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [editedAmount, setEditedAmount] = useState<string>();
  const cartCents = cents(total);
  const amount = editedAmount ?? total;
  const previewCents = previewUsdtCents(amount);
  const matchesCart = previewCents === cartCents;
  const previewAmount = previewCents === null ? "—" : fromCents(previewCents);

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
    setEditedAmount(undefined);
  }, [items]);

  useEffect(() => {
    setExpired(false);
    if (!quote) return;
    const timer = setTimeout(() => setExpired(true), Math.max(0, quote.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [quote]);

  function finish(id: string) {
    rememberOrder(id);
    clear();
    nav(`/success/${id}`, { replace: true });
  }

  async function submit() {
    if (busy || !matchesCart) return;
    setBusy(true);
    setError(undefined);
    const cart = { items, cartTotal: total };
    try {
      if (!method.simulated) {
        const order = await post<{ orderId: string }>("/api/checkout", cart);
        setOrderId(order.orderId);
      } else if (!quote || expired || quote.expiresAt <= Date.now()) {
        setQuote(await post<DemoQuote>("/api/checkout/demo-quote", { ...cart, methodId: method.id }));
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
    return <section className="gateway gateway-empty"><h1>Your cart is empty</h1><Link className="gateway-primary" to="/orders">View orders <Icon name="arrow" /></Link></section>;
  }

  return (
    <section className="gateway gateway-checkout">
      <div className="gateway-top">
        <Link to="/#catalog" className="gateway-back"><Icon name="left" /> Back to shop</Link>
        <span className="gateway-mode"><span /> {IS_DEMO ? "Demo checkout" : "Stablecoin checkout"}</span>
      </div>
      <div className="gateway-intro">
        <h1>Checkout</h1>
      </div>
      <div className="gateway-grid">
        <aside className="gateway-summary" aria-labelledby="summary-title">
          <div className="gateway-total">
            <img className="gateway-card-logo" src="/brand/quietpay-wordmark.png" alt="QuietPay" />
            <p id="summary-title">Order total</p>
            <strong>{total} <span>USDT</span></strong>
            <p>Quiet Store · {count} {count === 1 ? "item" : "items"}</p>
          </div>
          <div className="gateway-items">
            <h2>Order summary</h2>
            <ul>
              {PRODUCTS.filter((product) => items[product.id]).map((product) => (
                <li key={product.id}>
                  <ProductImage product={product} className="gateway-item-image" />
                  <div className="gateway-item-label"><strong>{product.name}</strong><small>{product.price} USDT each</small></div>
                  <div className="gateway-quantity" aria-label={`Quantity for ${product.name}`}>
                    <button type="button" aria-label={`Remove one ${product.name}`} disabled={busy || !!orderId} onClick={() => remove(product.id)}><Icon name="minus" /></button>
                    <span>{items[product.id]}</span>
                    <button type="button" aria-label={`Add one ${product.name}`} disabled={busy || !!orderId} onClick={() => add(product.id)}><Icon name="plus" /></button>
                  </div>
                  <span className="gateway-line-price">{fromCents(cents(product.price) * items[product.id]!)}</span>
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
              <div className="gateway-amount-field">
                <label htmlFor="payment-amount">Enter amount</label>
                <span className="gateway-currency">{method.symbol}</span>
                <div className="gateway-amount-value">
                  <input id="payment-amount" inputMode="decimal" maxLength={14} value={amount} onChange={(event) => {
                    setEditedAmount(event.target.value);
                    setQuote(undefined);
                    setError(undefined);
                  }} />
                </div>
              </div>
              <div className="gateway-asset-field">
                <span className={`gateway-token ${method.simulated ? "gateway-token-demo" : ""}`} aria-hidden="true">{method.symbol.slice(0, 1)}</span>
                <label htmlFor="payment-stablecoin">Pay with</label>
                <select id="payment-stablecoin" value={method.id} onChange={(event) => {
                  const selected = methods.find((entry) => entry.id === event.target.value);
                  if (selected) setMethod(selected);
                  setQuote(undefined);
                  setError(undefined);
                }}>
                  {methods.map((option) => <option key={option.id} value={option.id}>{option.name} · {option.symbol}</option>)}
                </select>
              </div>
              {!quote && <div className="gateway-quote gateway-preview" aria-live="polite">
                <p className="gateway-preview-label">{IS_DEMO ? "Conversion preview" : "Payment preview"}</p>
                <dl>
                  <div><dt>Stablecoin amount</dt><dd>{previewAmount} {method.symbol}</dd></div>
                  <div><dt>Order value in USDT</dt><dd>{previewAmount} USDT</dd></div>
                </dl>
                {method.simulated && <p>Illustrative rate · 1 {method.symbol} = 1 USDT</p>}
              </div>}
              {!matchesCart && <p className="gateway-amount-note">Checkout requires the order total. <button type="button" onClick={() => setEditedAmount(undefined)}>Use order total</button></p>}
            </fieldset>
          )}
          {quote && (
            <div className="gateway-quote">
              <dl>
                <div><dt>You pay</dt><dd>{quote.payAmount} {quote.symbol}</dd></div>
                <div><dt>Merchant receives</dt><dd>{quote.merchantAmount} USDT</dd></div>
                <div><dt>Merchant relay fee</dt><dd>{quote.relayFee} USDT</dd></div>
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
            <button type="button" onClick={() => void submit()} disabled={busy || !matchesCart} className="gateway-primary">
              {busy ? "Working…" : quote && !expired ? `Confirm ${quote.payAmount} ${quote.symbol}` : expired ? "Refresh quote" : "Continue to pay"}
              <Icon name="arrow" />
            </button>
          )}
          {error && <p role="alert" className="gateway-error">{error}</p>}
          <p className="gateway-fee-note"><span /> {method.simulated ? "Demo only. No funds will move." : "The merchant covers the relay fee."}</p>
        </div>
      </div>
    </section>
  );
}
