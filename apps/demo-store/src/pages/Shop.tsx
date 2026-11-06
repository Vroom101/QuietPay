import { Link } from "react-router-dom";
import { useCart } from "../cart";
import { PRODUCTS } from "../products";

export function Shop() {
  const { add, count, total } = useCart();
  return (
    <>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {PRODUCTS.map((p) => (
          <div key={p.id} className="rounded-lg border border-stone-200 bg-white p-3">
            <div className={`mb-3 h-28 rounded ${p.color}`} />
            <div className="font-medium">{p.name}</div>
            <div className="text-xs text-stone-500">{p.blurb}</div>
            <div className="mt-2 flex items-center justify-between">
              <span className="text-sm font-semibold">{p.price} USDT</span>
              <button onClick={() => add(p.id)} className="rounded bg-stone-900 px-2 py-1 text-xs text-white">
                Add
              </button>
            </div>
          </div>
        ))}
      </div>
      {count > 0 && (
        <div className="mt-8 flex items-center justify-between rounded-lg bg-white p-4 shadow-sm">
          <span>{count} item(s), {total} USDT</span>
          <Link to="/checkout" className="rounded bg-stone-900 px-4 py-2 text-white">Checkout</Link>
        </div>
      )}
    </>
  );
}
