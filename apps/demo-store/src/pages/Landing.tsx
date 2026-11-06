import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Icon } from "../Icon";
import "./Landing.css";

const logo = "/brand/quietpay-wordmark.png";

const products = [
  {
    id: "checkout", icon: "bag", title: "Checkout", category: "01 / ONLINE STORES",
    description: "A drop-in payment flow with order webhooks and a receipt customers can check.",
    headline: "Make paying the easy part.",
    steps: ["Create an order from your store", "Let the customer review and pay", "Confirm settlement with a signed webhook"],
    example: ["Payment amount", "25.00 USDT", "The store confirms the order after it receives the signed webhook."],
  },
  {
    id: "invoices", icon: "orders", title: "Invoices & links", category: "02 / CLIENT BILLING",
    description: "Share a payment link or send an invoice with a due date and reminder settings.",
    headline: "Get from work delivered to invoice paid.",
    steps: ["Set the amount, due date, and reminder preference", "Share a checkout link with your client", "Track the invoice through to payment"],
    example: ["Illustration project", "150.00 USDT", "A client opens the link, reviews the invoice, and pays through the same checkout."],
  },
  {
    id: "refunds", icon: "refund", title: "Refunds", category: "03 / AFTER PAYMENT",
    description: "Return part or all of a payment and keep the original receipt easy to find.",
    headline: "Make refunds easy to follow.",
    steps: ["Open a completed payment", "Review the amount and remaining refundable balance", "Confirm and check the original receipt"],
    example: ["Partial refund", "5.00 USDT", "The refund appears alongside the original payment so both sides can track it."],
  },
  {
    id: "subscriptions", icon: "repeat", title: "Subscriptions", category: "04 / RECURRING BILLING",
    description: "Preview a recurring plan with clear terms, a next charge date, and cancellation.",
    headline: "Make recurring billing clear from day one.",
    steps: ["Set an amount and billing interval", "Let customers review and accept the terms", "Show the next scheduled charge and cancellation"],
    example: ["Studio monthly", "18.00 USDT", "Demo signup and cancellation are available. Automated renewals are planned."],
  },
] as const;

function dashboardUrl() {
  return import.meta.env.VITE_MERCHANT_DASHBOARD_URL ||
    (["localhost", "127.0.0.1"].includes(window.location.hostname) ? "http://localhost:5174" : undefined);
}

function MerchantSignupLink({ className = "qp-button" }: { className?: string }) {
  const dashboard = dashboardUrl();
  if (!dashboard) return null;
  const signup = new URL(dashboard, window.location.origin);
  signup.searchParams.set("signup", "1");
  return <a className={className} href={signup.href}>Sign Up <Icon name="arrow" /></a>;
}

function MarketingHeader() {
  return (
    <header className="qp-marketing-header">
      <Link to="/" className="qp-nav-brand" aria-label="QuietPay home">
        <span className="qp-nav-wordmark" aria-hidden="true" style={{ maskImage: `url("${logo}")` }} />
      </Link>
      <nav aria-label="Main navigation">
        <Link to="/#products">Products</Link>
        <Link to="/#how-it-works">How it works</Link>
      </nav>
      <MerchantSignupLink className="qp-button qp-nav-cta" />
    </header>
  );
}

function MerchantLink({ className = "qp-button qp-button-secondary" }: { className?: string }) {
  const url = dashboardUrl();
  return url ? <a className={className} href={url}>Merchant dashboard <Icon name="arrow" /></a>
    : <Link className={className} to="/#products">Explore merchant tools <Icon name="arrow" /></Link>;
}

function MarketingFooter() {
  return (
    <footer className="qp-marketing-footer">
      <Link to="/" className="qp-nav-brand" aria-label="QuietPay home"><img src={logo} alt="" /></Link>
      <p>Checkout and billing tools for stablecoin payments.</p>
      <Link to="/shop">Open demo store <Icon name="arrow" /></Link>
    </footer>
  );
}

const chapters = [
  ["overview", "Overview"], ["use-cases", "Services"], ["products", "Products"],
  ["analytics", "Analytics"], ["how-it-works", "Whitechain"], ["demo", "Demo"],
] as const;

const audiences = [
  { title: "Shoppers", icon: "bag", headline: "Pay and get back to your day.", copy: "Review your order, approve a stablecoin payment, and find the receipt in your order history.", link: "/shop", action: "Visit the demo store" },
  { title: "Online stores", icon: "store", headline: "Keep payments and orders in sync.", copy: "Add checkout to your storefront and update orders with signed webhooks when funds settle.", link: "/product/checkout", action: "Explore checkout" },
  { title: "Studios & global teams", icon: "team", headline: "Give clients one link to pay.", copy: "Set an amount and due date, share an invoice link, and track when the payment comes in.", link: "/product/invoices", action: "Explore invoices" },
] as const;

const capabilities = [
  { icon: "spark", title: "Pay effortlessly", copy: "Review and approve a stablecoin payment in a few steps." },
  { icon: "layers", title: "Track everything", copy: "See your orders, payment status, and receipts in one place." },
  { icon: "shield", title: "Stay in control", copy: "Review payment details and keep a record of refunds." },
] as const;

function PaymentIllustration({ icon }: { icon: (typeof audiences)[number]["icon"] }) {
  return (
    <div className="qp-audience-art" aria-hidden="true">
      <div className="qp-audience-orbit" />
      <div className="qp-audience-platform" />
      <div className="qp-audience-object"><Icon name={icon} /></div>
      <div className="qp-audience-receipt"><Icon name="orders" /><span>✓</span></div>
    </div>
  );
}

function AudienceSection() {
  const [selected, setSelected] = useState(0);
  const audience = audiences[selected];

  return (
    <section className="qp-audiences qp-wrap" id="use-cases" aria-labelledby="audiences-title">
      <div className="qp-section-title">
        <span className="qp-audience-kicker"><Icon name="store" /> MERCHANT SERVICES</span>
        <h2 id="audiences-title">What are <em>you here</em> to do?</h2>
        <p>Choose your role and get started with payments, orders, and more.</p>
      </div>
      <div className="qp-audience-switch">
        <div className="qp-audience-options" role="group" aria-label="Choose a use case">
          {audiences.map((entry, index) => (
            <button key={entry.title} type="button" aria-pressed={selected === index} aria-controls="qp-audience-detail" onClick={() => setSelected(index)}>
              <Icon name={entry.icon} /><span>{entry.title}</span><Icon name="arrow" />
            </button>
          ))}
        </div>
        <div className="qp-audience-detail" id="qp-audience-detail" aria-live="polite">
          <div className="qp-audience-copy">
            <span className="qp-audience-badge"><Icon name={audience.icon} /> For {audience.title.toLowerCase()}</span>
            <h3>{audience.headline}</h3><p>{audience.copy}</p>
            <Link className="qp-button qp-audience-cta" to={audience.link}>{audience.action} <Icon name="arrow" /></Link>
          </div>
          <PaymentIllustration icon={audience.icon} />
        </div>
      </div>
      <div className="qp-capabilities-label"><Icon name="spark" /> WHAT YOU CAN DO</div>
      <div className="qp-capabilities">
        {capabilities.map(({ icon, title, copy }) => (
          <article key={title}><span className="qp-capability-icon"><Icon name={icon} /></span><div><h3>{title}</h3><p>{copy}</p></div></article>
        ))}
      </div>
    </section>
  );
}

export function Landing() {
  return (
    <div className="qp-marketing qp-home">
      <div className="qp-home-header"><MarketingHeader /></div>
      <main>
        <div className="qp-cloud-sky">
          <section className="qp-hero" id="overview" aria-labelledby="quietpay-title">
            <img className="qp-hero-logo" src={logo} alt="QuietPay" fetchPriority="high" />
            <span className="qp-hero-tag"><span /> STABLECOIN CHECKOUT & BILLING</span>
            <h1 id="quietpay-title">A simpler way to get paid.</h1>
            <p>Give customers a clear way to pay, and give your business a record of what came in, what went back, and what settled.</p>
            <div className="qp-hero-actions">
              <MerchantSignupLink />
              <Link to="/#use-cases" className="qp-button qp-button-glass">Explore services</Link>
            </div>
          </section>
        </div>

        <nav className="qp-chapters" aria-label="On this page">
          <div className="qp-wrap">{chapters.map(([id, title], index) => (
            <Link key={id} to={`/#${id}`}><span>0{index + 1}</span>{title}</Link>
          ))}</div>
        </nav>

        <AudienceSection />

        <section className="qp-product-section qp-wrap" id="products" aria-labelledby="products-title">
          <div className="qp-section-title">
            <span className="qp-audience-kicker"><Icon name="store" /> PAYMENT SERVICES</span>
            <h2 id="products-title">From the <em>first charge</em> to the next.</h2>
            <p>Accept payments, bill clients, and manage what happens after checkout.</p>
          </div>
          <div className="qp-product-grid">
            {products.map((product) => (
              <Link key={product.id} className={product.id === "checkout" ? "qp-product-card qp-product-featured" : "qp-product-card"} to={`/product/${product.id}`}>
                {product.id === "checkout" && (
                  <div className="qp-checkout-art">
                    <img src="/brand/checkout-usdt.webp" alt="" loading="lazy" width={800} height={1000} />
                  </div>
                )}
                <div className="qp-product-card-title">
                  <span className="qp-product-icon"><Icon name={product.icon} /></span>
                  <h3>{product.title}</h3>
                </div>
                <p>{product.description}</p>
                <div className="qp-card-preview">
                  <Icon name={product.id === "checkout" || product.id === "subscriptions" ? "layers" : product.icon} />
                  <span>{product.example[0]}</span><strong>{product.example[1]}</strong>
                </div>
                <span className="qp-card-action">View {product.title.toLowerCase()} <Icon name="arrow" /></span>
              </Link>
            ))}
          </div>
        </section>

        <section className="qp-analytics qp-wrap" id="analytics" aria-labelledby="analytics-title">
          <div className="qp-section-title"><span>04 / MERCHANT ANALYTICS</span><h2 id="analytics-title">See what you actually received.</h2><p>Track payments, fees, and refunds. Filter orders by status and export records for reconciliation.</p><MerchantLink /></div>
          <div className="qp-analytics-frame">
            <div className="qp-frame-bar"><span aria-hidden="true"><i /><i /><i /></span><span>PAYMENT OVERVIEW</span><span>SAMPLE DATA</span></div>
            <div className="qp-analytics-body">
              <p>Order breakdown <span>USDT</span></p>
              <dl>
                <div><dt>Gross payment</dt><dd>25.00</dd></div>
                <div><dt>Relay fee</dt><dd>−0.05</dd></div>
                <div><dt>Refunded</dt><dd>−5.00</dd></div>
                <div><dt>Net received</dt><dd>19.95</dd></div>
              </dl>
              <div className="qp-analytics-order"><span>Sample order</span><span className="qp-state">Partially refunded</span></div>
            </div>
          </div>
        </section>

        <div className="qp-network">
          <section className="qp-how qp-wrap" id="how-it-works" aria-labelledby="how-title">
            <div className="qp-how-copy">
              <div className="qp-section-title"><span>05 / WHITECHAIN SETTLEMENT</span><h2 id="how-title">Follow a payment to its receipt.</h2></div>
              <ol>
                <li><span>01</span><div><strong>Approve</strong><p>The customer reviews the amount and approves the payment.</p></div></li>
                <li><span>02</span><div><strong>Settle</strong><p>In the Whitechain testnet flow, the relayer pays gas in WBT. The merchant covers the relay fee from settlement.</p></div></li>
                <li><span>03</span><div><strong>Verify</strong><p>A signed webhook updates the order. An onchain payment can be checked using its transaction reference.</p></div></li>
              </ol>
            </div>
            <div className="qp-receipt-card" aria-label="Illustrative merchant payment summary">
              <div className="qp-receipt-top"><span className="qp-product-icon"><Icon name="orders" /></span><span>Example settlement receipt</span></div>
              <p>Payment amount</p><strong>25.00 <small>USDT</small></strong>
              <dl><div><dt>Merchant relay fee</dt><dd>0.05 USDT</dd></div><div><dt>Merchant receives</dt><dd>24.95 USDT</dd></div></dl>
              <span className="qp-receipt-note">Illustrative amounts</span>
            </div>
          </section>
        </div>

        <section className="qp-demo qp-wrap" id="demo" aria-labelledby="demo-title">
          <div className="qp-section-title"><span>06 / TRY QUIETPAY</span><h2 id="demo-title">See the payment from both sides.</h2></div>
          <div className="qp-demo-grid">
            <article><span>SHOPPER EXPERIENCE</span><h3>Place a demo order.</h3><p>Add an item to your cart, walk through checkout, and open the simulated receipt.</p><Link className="qp-button" to="/shop">Open demo store <Icon name="arrow" /></Link></article>
            <article><span>MERCHANT EXPERIENCE</span><h3>Follow the money.</h3><p>Open the merchant workspace to review payment status and manage refunds.</p><MerchantLink /></article>
          </div>
        </section>
      </main>
      <MarketingFooter />
    </div>
  );
}


export function ProductPage() {
  const { feature } = useParams();
  const product = products.find((entry) => entry.id === feature);

  return (
    <div className="qp-marketing">
      <div className="qp-sky qp-feature-sky">
        <MarketingHeader />
        <main className="qp-feature qp-wrap">
          <Link to="/#products" className="qp-feature-back"><Icon name="left" /> All products</Link>
          {product ? (
            <>
              <div className="qp-feature-copy"><span>{product.category}</span><h1>{product.headline}</h1><p>{product.description}</p></div>
              <div className="qp-feature-grid">
                <section className="qp-feature-panel"><h2>The flow</h2><ol>{product.steps.map((step, index) => <li key={step}><span>{String(index + 1).padStart(2, "0")}</span>{step}</li>)}</ol></section>
                <section className="qp-feature-panel qp-feature-example"><span className="qp-product-icon"><Icon name={product.icon} /></span><h2>{product.example[0]}</h2><strong>{product.example[1]}</strong><p>{product.example[2]}</p></section>
              </div>
              <div className="qp-hero-actions">{product.id === "checkout" ? <Link to="/shop" className="qp-button">Try checkout <Icon name="arrow" /></Link> : <MerchantLink className="qp-button" />}</div>
            </>
          ) : <div className="qp-feature-copy"><h1>Product unavailable</h1><p>Choose a product from the QuietPay overview.</p></div>}
        </main>
      </div>
      <MarketingFooter />
    </div>
  );
}
