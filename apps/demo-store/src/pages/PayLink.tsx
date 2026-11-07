import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { QuietpayCheckout } from "@quietpay/widget/react";
import { Icon } from "../Icon";
import type { CheckoutSession } from "../checkout-session";
import { LINK_STATUS_MESSAGE, getLink, startLinkCheckout, type PublicLinkView } from "../payment-links";

const RELAYER_URL = import.meta.env.VITE_RELAYER_URL || "http://localhost:8787";

export function PayLinkPage() {
  const { id } = useParams();
  return <PayLink key={id} id={id ?? ""} />;
}

function PayLink({ id }: { id: string }) {
  const [link, setLink] = useState<PublicLinkView>();
  const [loadError, setLoadError] = useState<string>();
  const [session, setSession] = useState<CheckoutSession>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();

  useEffect(() => {
    const controller = new AbortController();
    getLink(id, controller.signal)
      .then((loaded) => { if (!controller.signal.aborted) setLink(loaded); })
      .catch((cause: Error) => { if (!controller.signal.aborted) setLoadError(cause.message); });
    return () => controller.abort();
  }, [id]);

  async function submit() {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      setSession(await startLinkCheckout(id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "We could not start your payment. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!link) {
    return (
      <section className="gateway gateway-receipt">
        <h1>Payment link</h1>
        <p role="status">{loadError ?? "Loading payment link…"}</p>
      </section>
    );
  }

  const unavailable = link.status === "active" ? undefined : LINK_STATUS_MESSAGE[link.status];
  return (
    <section className="gateway gateway-checkout">
      <div className="gateway-top">
        <span />
        <span className="gateway-mode"><span /> Stablecoin checkout</span>
      </div>
      <div className="gateway-intro">
        <h1>{link.title}</h1>
        {link.description && <p>{link.description}</p>}
      </div>
      <div className="gateway-grid">
        <aside className="gateway-summary" aria-labelledby="summary-title">
          <div className="gateway-total">
            <img className="gateway-card-logo" src="/brand/quietpay-wordmark.png" alt="QuietPay" />
            <p id="summary-title" className="gateway-total-label">Amount due</p>
            <div className={`gateway-card-amount${link.amount.length > 8 ? " gateway-card-amount-long" : ""}`}>
              <strong>{link.amount}</strong><span>USDT</span>
            </div>
            <p className="gateway-card-merchant"><Icon name="store" /> {link.merchantName}</p>
          </div>
        </aside>
        <div className="gateway-payment">
          <div className="gateway-console-heading">
            <h2>{session ? "Review payment" : "Pay with stablecoin"}</h2>
            <span>Payment link</span>
          </div>
          {unavailable ? (
            <p role="status" className="gateway-receipt-status">{unavailable}</p>
          ) : session ? (
            // Amount and payout come from the store's own server; the widget refuses to sign anything else.
            <QuietpayCheckout
              orderId={session.orderId}
              relayerUrl={RELAYER_URL}
              expectedAmount={session.amount}
              expectedPayout={session.payout}
              onSettled={() => nav(`/success/${session.orderId}`, { replace: true })}
            />
          ) : (
            <button type="button" onClick={() => void submit()} disabled={busy} className="gateway-primary">
              {busy ? "Working…" : "Pay with stablecoin"}
              <Icon name="arrow" />
            </button>
          )}
          {error && <p role="alert" className="gateway-error">{error}</p>}
        </div>
      </div>
    </section>
  );
}
