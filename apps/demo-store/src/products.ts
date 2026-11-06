export type Category = "Home" | "Everyday" | "Stationery" | "Lighting";

export interface Product {
  id: string;
  name: string;
  blurb: string;
  price: string;
  category: Category;
  imagePosition?: string;
}

export const PRODUCTS: Product[] = [
  { id: "mug", name: "Ceramic Mug", blurb: "Hand-glazed, 350 ml", price: "12.00", category: "Home", imagePosition: "0% 0%" },
  { id: "tee", name: "Cotton Tee", blurb: "Heavyweight cotton", price: "25.00", category: "Everyday", imagePosition: "100% 0%" },
  { id: "notebook", name: "Dot Notebook", blurb: "A5, 120 pages", price: "8.50", category: "Stationery", imagePosition: "0% 100%" },
  { id: "bag", name: "Canvas Tote", blurb: "Waxed canvas", price: "40.00", category: "Everyday", imagePosition: "100% 100%" },
  { id: "lamp", name: "Arc Pendant", blurb: "Matte stone and opal glass", price: "45.90", category: "Lighting" },
];

export const cents = (price: string) => Math.round(Number(price) * 100);
export const fromCents = (c: number) => (c / 100).toFixed(2);
