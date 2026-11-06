import { LitElement, css, html, nothing } from "lit";
import { formatUsdt, type Order } from "@quietpay/shared";
import type { PrivateKeyAccount } from "viem/accounts";
import { WidgetError, fetchOrder, pollOrder, relayPay, signCheckout } from "./client.js";
import { getOrCreateAccount } from "./keystore.js";
import { GENERIC_MESSAGE, TIMEOUT_MESSAGE, messageForCode } from "./messages.js";

type View = "loading" | "ready" | "paying" | "settled" | "error";

const STEPS: Record<string, string> = {
  signing: "Approve the payment...",
  sending: "Sending your payment...",
  confirming: "Confirming your payment...",
};

const short = (s: string) => `${s.slice(0, 8)}...${s.slice(-6)}`;

export class QuietpayCheckout extends LitElement {
  static properties = {
    orderId: { type: String, attribute: "order-id" },
    relayerUrl: { type: String, attribute: "relayer-url" },
    expectedRouter: { type: String, attribute: "expected-router" },
    expectedAmount: { type: String, attribute: "expected-amount" },
    expectedToken: { type: String, attribute: "expected-token" },
    expectedDomainName: { type: String, attribute: "expected-domain-name" },
    expectedDomainVersion: { type: String, attribute: "expected-domain-version" },
    view: { state: true },
    order: { state: true },
    account: { state: true },
    step: { state: true },
    errorMessage: { state: true },
    errorCode: { state: true },
  };

  declare orderId: string;
  declare relayerUrl: string;
  declare expectedRouter: string | undefined;
  declare expectedAmount: string | undefined;
  declare expectedToken: string | undefined;
  declare expectedDomainName: string | undefined;
  declare expectedDomainVersion: string | undefined;
  declare view: View;
  declare order: Order | undefined;
  declare account: PrivateKeyAccount | undefined;
  declare step: string;
  declare errorMessage: string;
  declare errorCode: string;

  constructor() {
    super();
    this.orderId = "";
    this.relayerUrl = "";
    this.view = "loading";
    this.order = undefined;
    this.account = undefined;
    this.step = "";
    this.errorMessage = "";
    this.errorCode = "";
  }

  static styles = css`
    :host { display: block; font-family: system-ui, sans-serif; color: #111827; max-width: 24rem; }
    .card { border: 1px solid #e5e7eb; border-radius: 12px; padding: 1.25rem; background: #fff; }
    .amount { font-size: 2rem; font-weight: 700; margin: .25rem 0; }
    .muted { color: #6b7280; font-size: .8rem; }
    .row { display: flex; justify-content: space-between; gap: .5rem; margin: .35rem 0; font-size: .9rem; }
    code { font-size: .75rem; word-break: break-all; }
    button { width: 100%; padding: .75rem; border: 0; border-radius: 8px; background: #111827; color: #fff; font-size: 1rem; cursor: pointer; margin-top: .75rem; }
    button[disabled] { opacity: .5; cursor: default; }
    button.secondary { background: #e5e7eb; color: #111827; }
    .error { background: #fef2f2; color: #991b1b; padding: .75rem; border-radius: 8px; margin: .5rem 0; font-size: .9rem; }
    .ok { background: #ecfdf5; color: #065f46; padding: .75rem; border-radius: 8px; margin: .5rem 0; }
    .footer { margin-top: 1rem; font-size: .7rem; color: #6b7280; }
    a { color: #2563eb; }
  `;

  connectedCallback() {
    super.connectedCallback();
    void this.load();
  }

  updated(changed: Map<string, unknown>) {
    // Reload when the order id / relayer changes after the first render.
    if ((changed.has("orderId") && changed.get("orderId") !== undefined && changed.get("orderId") !== "") ||
        (changed.has("relayerUrl") && changed.get("relayerUrl") !== undefined && changed.get("relayerUrl") !== "")) {
      void this.load();
    }
  }

  private emit(name: string, detail: unknown) {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }

  private fail(err: unknown) {
    const code = err instanceof WidgetError ? err.code : "unknown";
    this.errorCode = code;
    if (code === "timeout") this.errorMessage = TIMEOUT_MESSAGE;
    else if (code === "payment_details_changed") this.errorMessage = "We couldn't verify the payment details. Check your order before trying again.";
    else if (code === "network" && err instanceof WidgetError) this.errorMessage = err.message;
    else this.errorMessage = messageForCode(code);
    this.view = "error";
    this.emit("quietpay:error", { code, message: this.errorMessage });
  }

  private showOrder(o: Order) {
    this.order = o;
    if (o.status === "settled") {
      this.view = "settled";
      this.emit("quietpay:settled", { order: o });
    } else if (o.status === "expired") {
      this.fail(new WidgetError("order_expired", ""));
    } else if (o.status === "failed") {
      this.fail(new WidgetError(o.failureCode ?? "unknown", ""));
    } else {
      this.view = "ready";
    }
  }

  async load() {
    if (!this.orderId || !this.relayerUrl) return;
    this.view = "loading";
    try {
      this.account = await getOrCreateAccount();
      this.showOrder(await fetchOrder(this.relayerUrl, this.orderId));
    } catch (e) {
      this.fail(e);
    }
  }

  async pay() {
    const reviewedOrder = this.order;
    if (this.view !== "ready" || !reviewedOrder) return;
    const { orderId, relayerUrl } = this;
    const expected = {
      router: this.expectedRouter,
      amount: this.expectedAmount,
      token: this.expectedToken ?? undefined,
      domainName: this.expectedDomainName ?? undefined,
      domainVersion: this.expectedDomainVersion ?? undefined,
      reviewedOrder,
    };
    try {
      this.view = "paying";
      this.step = "sending";
      const account = this.account ?? (await getOrCreateAccount());
      this.account = account;
      // Recheck the latest details against the order the customer saw.
      const order = await fetchOrder(relayerUrl, orderId);
      if (order.status === "pending") {
        this.step = "confirming";
        this.showOrder(await pollOrder(relayerUrl, orderId, { onUpdate: (o) => (this.order = o) }));
        return;
      }
      if (order.status !== "created") {
        this.showOrder(order);
        return;
      }
      this.step = "signing";
      const req = await signCheckout(account, order, undefined, expected);
      this.step = "sending";
      await relayPay(relayerUrl, req);
      this.step = "confirming";
      const final = await pollOrder(relayerUrl, orderId, {
        onUpdate: (o) => (this.order = o),
      });
      this.showOrder(final);
    } catch (e) {
      this.fail(e);
    }
  }

  private renderSummary(o: Order) {
    return html`
      <div class="muted">Pay merchant ${short(o.merchantId)}${o.reference ? html` &middot; ${o.reference}` : nothing}</div>
      <div class="amount">${formatUsdt(o.amount)} USDT</div>
    `;
  }

  private renderWallet() {
    if (!this.account) return nothing;
    return html`
      <div class="muted">Your payment address (add USDT here to pay):</div>
      <code data-testid="payer">${this.account.address}</code>
    `;
  }

  render() {
    const o = this.order;
    let body;
    switch (this.view) {
      case "loading":
        body = html`<p>Loading your order...</p>`;
        break;
      case "ready":
        body = html`
          ${o ? this.renderSummary(o) : nothing}
          <button @click=${() => void this.pay()}>Pay ${o ? formatUsdt(o.amount) : ""} USDT</button>
          ${this.renderWallet()}
        `;
        break;
      case "paying":
        body = html`
          ${o ? this.renderSummary(o) : nothing}
          <p data-testid="step">${STEPS[this.step] ?? ""}</p>
          <button disabled>Working...</button>
          ${this.renderWallet()}
        `;
        break;
      case "settled":
        body = html`
          <div class="ok">Payment complete. Thank you!</div>
          ${o ? html`<div class="amount">${formatUsdt(o.amount)} USDT</div>` : nothing}
          ${o?.payer ? html`<div class="row"><span>Paid by</span><code>${o.payer}</code></div>` : nothing}
          ${o?.txHash ? html`<div class="row"><span>Receipt</span><code data-testid="receipt">${o.txHash}</code></div>` : nothing}
          ${o?.explorerUrl
            ? html`<a href=${o.explorerUrl} target="_blank" rel="noopener noreferrer">View receipt online</a>`
            : nothing}
        `;
        break;
      case "error":
        body = html`
          <div class="error" role="alert" data-code=${this.errorCode}>${this.errorMessage || GENERIC_MESSAGE}</div>
          ${this.errorCode !== "order_not_found" && this.errorCode !== "order_expired" && this.errorCode !== "already_settled"
            ? html`<button class="secondary" @click=${() => void this.load()}>Try again</button>`
            : nothing}
          ${this.renderWallet()}
        `;
        break;
    }
    return html`
      <div class="card">
        ${body}
        <div class="footer">
          Demo wallet: your key is kept only in this browser and is not meant for real funds.
          Powered by Quietpay.
        </div>
      </div>
    `;
  }
}

if (!customElements.get("quietpay-checkout")) {
  customElements.define("quietpay-checkout", QuietpayCheckout);
}

declare global {
  interface HTMLElementTagNameMap {
    "quietpay-checkout": QuietpayCheckout;
  }
}
