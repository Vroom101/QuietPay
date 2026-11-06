export interface Product {
  id: string;
  name: string;
  blurb: string;
  /** USDT, two decimals. */
  price: string;
  color: string;
}

export const PRODUCTS: Product[] = [
  { id: "mug", name: "Ceramic Mug", blurb: "Hand-glazed, 350 ml.", price: "12.00", color: "bg-amber-200" },
  { id: "tee", name: "Cotton Tee", blurb: "Heavyweight, relaxed fit.", price: "25.00", color: "bg-sky-200" },
  { id: "notebook", name: "Dot Notebook", blurb: "A5, 120 pages.", price: "8.50", color: "bg-rose-200" },
  { id: "bag", name: "Canvas Tote", blurb: "Roomy, waxed canvas.", price: "40.00", color: "bg-emerald-200" },
];

export const cents = (price: string) => Math.round(Number(price) * 100);
export const fromCents = (c: number) => (c / 100).toFixed(2);
