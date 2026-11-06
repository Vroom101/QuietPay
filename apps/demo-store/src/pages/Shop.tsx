import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useCart } from "../cart";
import { Icon } from "../Icon";
import { ProductImage } from "../ProductImage";
import { PRODUCTS, type Product } from "../products";

const categories = ["Home", "Everyday", "Stationery", "Lighting"];
const lamp = PRODUCTS[4]!;
const slides = [
  { title: "Make room for the everyday.", copy: "Considered pieces for the spaces you call home.", image: "/shop/living-room.webp", category: "Home", label: "The home edit" },
  { title: "A softer kind of light.", copy: "A quiet statement for the corner you love most.", image: "/shop/arc-pendant.webp", category: "Lighting", label: "The lighting edit" },
];

export function Shop({ saved, toggleSaved }: { saved: string[]; toggleSaved: (id: string) => void }) {
  const { add, count, items } = useCart();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [slide, setSlide] = useState(0);
  const [query, setQuery] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const activeSlide = slides[slide]!;
  const view = params.get("view");
  const defaultCategory = view ? "All" : "Popular";
  const category = params.get("category") ?? defaultCategory;
  const search = view === "search" ? query.trim().toLowerCase() : "";
  const products = PRODUCTS.filter((product) =>
    (category === "All" || (category === "Popular" && product.id !== lamp.id) || product.category === category) &&
    (view !== "saved" || saved.includes(product.id)) &&
    `${product.name} ${product.blurb} ${product.category}`.toLowerCase().includes(search),
  );

  function changeSlide(direction: number) {
    setSlide((current) => (current + direction + slides.length) % slides.length);
  }

  function addProduct(product: Product) {
    add(product.id);
    setAnnouncement(`${product.name} added to your cart. ${(items[product.id] ?? 0) + 1} in cart.`);
  }

  return (
    <>
      <section className="shop-hero" aria-label="Featured collections">
        <div className={`editorial-panel ${slide === 1 ? "editorial-lighting" : ""}`} style={{ backgroundImage: `url(${activeSlide.image})` }}>
          <div className="editorial-copy">
            <span className="editorial-icon"><Icon name="spark" /></span>
            <div>
              <p className="eyebrow">The quiet edit</p>
              <h1>{activeSlide.title}</h1>
              <p className="editorial-description">{activeSlide.copy}</p>
            </div>
          </div>
          <div className="editorial-bar">
            <Link to={`/?category=${activeSlide.category}#catalog`} className="collection-link">
              <ProductImage product={slide === 0 ? PRODUCTS[0]! : lamp} className="collection-thumb" />
              <span><strong>{activeSlide.label}</strong><small>Explore the collection</small></span>
            </Link>
            <div className="slide-controls">
              <button type="button" onClick={() => changeSlide(-1)} aria-label="Previous collection"><Icon name="left" /></button>
              <span>{String(slide + 1).padStart(2, "0")} / {String(slides.length).padStart(2, "0")}</span>
              <button type="button" onClick={() => changeSlide(1)} aria-label="Next collection"><Icon name="right" /></button>
            </div>
          </div>
        </div>

        <article className="spotlight-panel">
          <img className="spotlight-image" src="/shop/arc-pendant.webp" alt="Arc Pendant with a matte stone shade and an opal globe" fetchPriority="high" />
          <span className="spotlight-tag"><span /> Featured piece</span>
          <div className="spotlight-footer">
            <div><h2>{lamp.name}</h2><p>{lamp.blurb}</p></div>
            <button className="pill-button" onClick={() => addProduct(lamp)}>Add to cart <span>${lamp.price}</span></button>
          </div>
        </article>
      </section>

      <section className="catalog" id="catalog" aria-labelledby="catalog-title">
        <div className="catalog-header">
          <div><p className="eyebrow catalog-eyebrow">The essentials</p><h2 id="catalog-title">{view === "saved" ? "Saved products" : view === "search" ? "Search products" : "Popular products"}</h2></div>
          <div className="category-list" role="group" aria-label="Filter products by category">
            {[defaultCategory, ...categories].map((name) => (
              <button key={name} type="button" aria-pressed={category === name} onClick={() => {
                const next = new URLSearchParams(params);
                if (name === defaultCategory) next.delete("category");
                else next.set("category", name);
                navigate({ search: next.toString(), hash: "#catalog" }, { replace: true });
              }}>{name}</button>
            ))}
          </div>
        </div>
        {view === "search" && <label className="catalog-search"><Icon name="search" /><input autoFocus type="search" placeholder="Search the collection" aria-label="Search the collection" value={query} onChange={(event) => setQuery(event.target.value)} /></label>}
        {products.length === 0 && <p className="catalog-empty">{view === "saved" ? "No saved products in this view." : "No products match your search."}</p>}
        <div className="product-grid">
          {products.map((product) => {
            const isSaved = saved.includes(product.id);
            return (
              <article className="product-card" key={product.id}>
                <div className="product-visual">
                  <ProductImage product={product} />
                  <button className="save-button" type="button" aria-label={`Save ${product.name}`} aria-pressed={isSaved} onClick={() => toggleSaved(product.id)}><Icon name="heart" /></button>
                </div>
                <div className="product-details">
                  <div>
                    <p className="product-price">${product.price}</p>
                    <h3>{product.name}</h3>
                    <p className="product-description">{product.blurb}</p>
                  </div>
                  <button className="product-add" type="button" aria-label={`Add ${product.name} to cart`} onClick={() => addProduct(product)}><Icon name="plus" /></button>
                </div>
              </article>
            );
          })}
        </div>
        <p className="sr-only" role="status">{announcement}</p>
      </section>
      {count > 0 && (
        <div className="shopping-bag-bar">
          <span>{count} {count === 1 ? "item" : "items"} in your cart</span>
          <Link to="/checkout" className="pill-button">Checkout <Icon name="arrow" /></Link>
        </div>
      )}
    </>
  );
}
