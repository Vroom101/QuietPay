import { Link, Route, Routes, useLocation } from "react-router-dom";
import { useEffect, useState } from "react";
import { useCart } from "./cart";
import { Icon } from "./Icon";
import { Shop } from "./pages/Shop";
import { Checkout } from "./pages/Checkout";
import { Success } from "./pages/Success";
import { Orders } from "./pages/Orders";

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
  const isCheckout = location.pathname === "/checkout";
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

  return (
    <div className={isCheckout ? "store-shell store-checkout-shell" : "store-shell"}>
      <header className="store-header">
        <nav className="store-nav" aria-label="Shop">
          <Link to="/#catalog">Catalog</Link>
          <Link to="/?category=Home#catalog">Home</Link>
          <Link to="/?category=Everyday#catalog">Everyday</Link>
        </nav>
        <Link to="/" className="store-brand" aria-label="Quiet Store home"><span>quiet</span>store<span className="brand-dot">.</span></Link>
        <nav className="store-actions" aria-label="Shopping tools">
          <Link to={view === "search" ? "/#catalog" : "/?view=search#catalog"} className="icon-link" aria-label="Search products"><Icon name="search" /></Link>
          <Link to={view === "saved" ? "/#catalog" : "/?view=saved#catalog"} className={view === "saved" ? "icon-link active" : "icon-link"} aria-label="Saved products"><Icon name="heart" /></Link>
          <Link to="/orders" className="icon-link" aria-label="Orders"><Icon name="orders" /></Link>
          <Link to="/checkout" className="icon-link cart-link" aria-label={`Cart (${count})`}><Icon name="bag" />{count > 0 && <span className="cart-count">{count}</span>}</Link>
        </nav>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<Shop saved={saved} toggleSaved={toggleSaved} />} />
          <Route path="/checkout" element={<Checkout />} />
          <Route path="/success/:orderId" element={<Success />} />
          <Route path="/orders" element={<Orders />} />
        </Routes>
      </main>
      {!isPaymentRoute && <footer className="store-footer">
        <span className="store-brand footer-brand"><span>quiet</span>store<span className="brand-dot">.</span></span>
        <span>QuietPay demo store · Checkout in demo USDT</span>
        <Link to="/#catalog">Browse the catalog <Icon name="arrow" /></Link>
      </footer>}
    </div>
  );
}
