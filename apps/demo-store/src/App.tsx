import { Link, Route, Routes } from "react-router-dom";
import { useCart } from "./cart";
import { Shop } from "./pages/Shop";
import { Checkout } from "./pages/Checkout";
import { Success } from "./pages/Success";

export function App() {
  const { count } = useCart();
  return (
    <div className="mx-auto max-w-4xl px-4 py-6">
      <header className="mb-8 flex items-center justify-between border-b border-stone-200 pb-4">
        <Link to="/" className="text-xl font-semibold">Demo Store</Link>
        <Link to="/checkout" className="text-sm text-stone-600">Cart ({count})</Link>
      </header>
      <Routes>
        <Route path="/" element={<Shop />} />
        <Route path="/checkout" element={<Checkout />} />
        <Route path="/success/:orderId" element={<Success />} />
      </Routes>
    </div>
  );
}
