import { Link, Route, Routes, useLocation } from "react-router-dom";
import { useEffect, useState } from "react";
import { useCart } from "./cart";
import { Icon } from "./Icon";
import { Shop } from "./pages/Shop";
import { Checkout } from "./pages/Checkout";
import { Cart } from "./pages/Cart";
import { Success } from "./pages/Success";
import { Orders } from "./pages/Orders";
import { InvoicePage, SubscribePage, SubscriptionPage } from "./pages/Billing";
import { Landing, ProductPage } from "./pages/Landing";

function loadSaved(): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem("quietpay-shop-saved") ?? "[]");
    return Array.isArray(saved) ? saved.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export function App() {
  const { count } = useCart();
  const [saved, setSaved] = useState(loadSaved);
  const location = useLocation();
  const view = new URLSearchParams(location.search).get("view");
  const isCheckout = location.pathname === "/checkout" || location.pathname.startsWith("/checkout/invoice/");
  const isPaymentRoute = isCheckout || location.pathname.startsWith("/success/") || location.pathname === "/orders";

  useEffect(() => {
    try {
      localStorage.setItem("quietpay-shop-saved", JSON.stringify(saved));
    } catch {
      // Favorites still work in memory when browser storage is unavailable.
    }
  }, [saved]);

  useEffect(() => {
    if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
    else window.scrollTo(0, 0);
  }, [location.pathname, location.hash]);

  function toggleSaved(id: string) {
    setSaved((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  }

  if (location.pathname === "/" || location.pathname.startsWith("/product/")) {
    return <Routes><Route path="/" element={<Landing />} /><Route path="/product/:feature" element={<ProductPage />} /></Routes>;
  }

  return (
    <div className={isCheckout ? "store-shell store-checkout-shell" : "store-shell"}>
      <header className="store-header">
        <nav className="store-nav" aria-label="Shop">
          <Link to="/shop#catalog">Catalog</Link>
          <Link to="/shop?category=Home#catalog">Home</Link>
          <Link to="/shop?category=Everyday#catalog">Everyday</Link>
        </nav>
        <Link to="/shop" className="store-brand" aria-label="Quiet Store home"><span>quiet</span>store<span className="brand-dot">.</span></Link>
        <nav className="store-actions" aria-label="Shopping tools">
          <Link to={view === "search" ? "/shop#catalog" : "/shop?view=search#catalog"} className="icon-link" aria-label="Search products"><Icon name="search" /></Link>
          <Link to={view === "saved" ? "/shop#catalog" : "/shop?view=saved#catalog"} className={view === "saved" ? "icon-link active" : "icon-link"} aria-label="Saved products"><Icon name="heart" /></Link>
          <Link to="/orders" className="icon-link" aria-label="Orders"><Icon name="orders" /></Link>
          <Link to="/cart" className="icon-link cart-link" aria-label={`Cart (${count})`}><Icon name="bag" />{count > 0 && <span className="cart-count">{count}</span>}</Link>
        </nav>
      </header>
      <main>
        <Routes>
          <Route path="/shop" element={<Shop saved={saved} toggleSaved={toggleSaved} />} />
          <Route path="/cart" element={<Cart />} />
          <Route path="/checkout" element={<Checkout />} />
          <Route path="/checkout/invoice/:id" element={<InvoicePage checkout />} />
          <Route path="/invoice/:id" element={<InvoicePage />} />
          <Route path="/subscribe/:id" element={<SubscribePage />} />
          <Route path="/subscription/:id" element={<SubscriptionPage />} />
          <Route path="/success/:orderId" element={<Success />} />
          <Route path="/orders" element={<Orders />} />
        </Routes>
      </main>
      {!isPaymentRoute && <footer className="store-footer">
        <span className="store-brand footer-brand"><span>quiet</span>store<span className="brand-dot">.</span></span>
        <span>QuietPay demo store · Checkout in demo USDT</span>
        <Link to="/">About QuietPay <Icon name="arrow" /></Link>
      </footer>}
    </div>
  );
}
