import { LitElement, css, html, nothing } from "lit";
import { formatUsdt, parseUsdt, type Order } from "@quietpay/shared";
import type { PrivateKeyAccount } from "viem/accounts";
import { WidgetError, fetchOrder, pollOrder, relayPay, signCheckout, verifyCheckout, type ExpectedCheckout } from "./client.js";
import { KeystoreError, getOrCreateAccount } from "./keystore.js";
import { GENERIC_MESSAGE, TIMEOUT_MESSAGE, messageForCode } from "./messages.js";

type View = "loading" | "ready" | "paying" | "settled" | "error";

const STEPS: Record<string, string> = {
  signing: "Approve the payment...",
  sending: "Sending your payment...",
  confirming: "Confirming your payment...",
};

const short = (s: string) => `${s.slice(0, 8)}...${s.slice(-6)}`;

/** Returns the URL only when it parses as http(s); javascript:, data:, vbscript: etc. yield null. */
export function safeHttpUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

export class QuietpayCheckout extends LitElement {
  static properties = {
    orderId: { type: String, attribute: "order-id" },
    relayerUrl: { type: String, attribute: "relayer-url" },
    // Expected checkout values. Defaults are the qualifying chain 1874, the official USDT, the deployed router and
    // the token's EIP-712 domain; override only for local test chains. They come from the host page, never the relayer.
    chainId: { type: Number, attribute: "chain-id" },
    token: { type: String, attribute: "token" },
    router: { type: String, attribute: "router" },
    domainName: { type: String, attribute: "domain-name" },
    domainVersion: { type: String, attribute: "domain-version" },
    /** Decimal USDT amount (e.g. "25.5") the shop expects; the order must match it exactly. */
    expectedAmount: { type: String, attribute: "expected-amount" },
    /** Optional merchant payout address the shop pins. */
    expectedPayout: { type: String, attribute: "expected-payout" },
    view: { state: true },
    order: { state: true },
    account: { state: true },
    step: { state: true },
    errorMessage: { state: true },
    errorCode: { state: true },
  };

  declare orderId: string;
  declare relayerUrl: string;
  declare chainId: number | undefined;
  declare token: string | undefined;
  declare router: string | undefined;
  declare domainName: string | undefined;
  declare domainVersion: string | undefined;
  declare expectedAmount: string | undefined;
  declare expectedPayout: string | undefined;
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

  /** What the checkout must look like, from the host page's attributes/properties (never from the relayer). */
  private expectedCheckout(): ExpectedCheckout {
    const opt = (s: string | undefined | null) => (s === undefined || s === null || s === "" ? undefined : s);
    let amount: bigint | undefined;
    const rawAmount = opt(this.expectedAmount);
    if (rawAmount !== undefined) {
      try {
        amount = parseUsdt(rawAmount.trim());
      } catch {
        throw new WidgetError("checkout_config_invalid", "expected-amount is not a valid amount");
      }
    }
    if (this.chainId !== undefined && this.chainId !== null && !Number.isSafeInteger(this.chainId)) {
      throw new WidgetError("checkout_config_invalid", "chain-id is not an integer");
    }
    return {
      orderId: this.orderId,
      chainId: this.chainId ?? undefined,
      token: opt(this.token),
      router: opt(this.router),
      domainName: opt(this.domainName),
      domainVersion: opt(this.domainVersion),
      amount,
      payout: opt(this.expectedPayout),
    };
  }

  private fail(err: unknown) {
    const code = err instanceof WidgetError ? err.code : err instanceof KeystoreError && err.code === "unreadable" ? "wallet_unreadable" : "unknown";
    this.errorCode = code;
    if (code === "timeout") this.errorMessage = TIMEOUT_MESSAGE;
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
    if (this.view === "paying") return;
    try {
      this.view = "paying";
      this.step = "sending";
      const account = this.account ?? (await getOrCreateAccount());
      this.account = account;
      // Fresh copy of the order so the amount we sign is what the relayer holds now.
      const order = await fetchOrder(this.relayerUrl, this.orderId);
      this.order = order;
      if (order.status === "pending") {
        this.step = "confirming";
        this.showOrder(await pollOrder(this.relayerUrl, this.orderId, { onUpdate: (o) => (this.order = o) }));
        return;
      }
      if (order.status !== "created") {
        this.showOrder(order);
        return;
      }
      // Never sign what the relayer hands us without checking it: chain, token, router, domain, amount, fee, payout
      // and the nonce recomputed locally. A refusal throws WidgetError("checkout_*") and nothing is signed.
      const expected = this.expectedCheckout();
      verifyCheckout(order, expected);
      this.step = "signing";
      const req = await signCheckout(account, order, undefined, { expected });
      this.step = "sending";
      await relayPay(this.relayerUrl, req);
      this.step = "confirming";
      const final = await pollOrder(this.relayerUrl, this.orderId, {
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
          ${safeHttpUrl(o?.explorerUrl)
            ? html`<a href=${safeHttpUrl(o?.explorerUrl)} target="_blank" rel="noopener noreferrer">View receipt online</a>`
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
