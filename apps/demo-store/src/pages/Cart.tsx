import { Link } from "react-router-dom";
import { useCart } from "../cart";
import { Icon } from "../Icon";
import { ProductImage } from "../ProductImage";
import { PRODUCTS, cents, fromCents } from "../products";

export function Cart() {
  const { items, count, total, add, remove } = useCart();

  return (
    <section className="cart-page">
      <Link to="/shop#catalog" className="gateway-back"><Icon name="left" /> Continue shopping</Link>
      <h1>Your cart</h1>
      {count === 0 ? (
        <div className="cart-items cart-empty">
          <Icon name="bag" />
          <h2>Your cart is empty</h2>
          <Link to="/shop#catalog" className="pill-button">Browse products <Icon name="arrow" /></Link>
        </div>
      ) : (
        <div className="cart-grid">
          <ul className="cart-items" aria-label="Cart items">
            {PRODUCTS.filter((product) => items[product.id]).map((product) => {
              const quantity = items[product.id]!;
              return (
                <li className="cart-item" key={product.id}>
                  <ProductImage product={product} className="cart-product-image" />
                  <div className="cart-item-name"><h2>{product.name}</h2><p>{product.price} USDT each</p></div>
                  <div className="cart-quantity" role="group" aria-label={`Quantity for ${product.name}`}>
                    <button type="button" aria-label={`Remove one ${product.name}`} onClick={() => remove(product.id)}><Icon name="minus" /></button>
                    <span>{quantity}</span>
                    <button type="button" aria-label={`Add one ${product.name}`} onClick={() => add(product.id)}><Icon name="plus" /></button>
                  </div>
                  <strong className="cart-line-price">{fromCents(cents(product.price) * quantity)} USDT</strong>
                </li>
              );
            })}
          </ul>
          <aside className="cart-summary" aria-labelledby="cart-summary-title">
            <h2 id="cart-summary-title">Order summary</h2>
            <p>{count} {count === 1 ? "item" : "items"}</p>
            <div className="cart-summary-total"><span>Total</span><strong>{total} USDT</strong></div>
            <Link to="/checkout" className="gateway-primary">Proceed to checkout <Icon name="arrow" /></Link>
          </aside>
        </div>
      )}
    </section>
  );
}
