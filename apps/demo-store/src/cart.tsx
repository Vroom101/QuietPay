import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { PRODUCTS, cents, fromCents } from "./products";

interface CartValue {
  items: Record<string, number>;
  add(id: string): void;
  remove(id: string): void;
  clear(): void;
  count: number;
  total: string;
}

const Ctx = createContext<CartValue | null>(null);

export function CartProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Record<string, number>>({});
  const value = useMemo<CartValue>(() => {
    const sum = PRODUCTS.reduce((s, p) => s + (items[p.id] ?? 0) * cents(p.price), 0);
    return {
      items,
      add: (id) => setItems((i) => ({ ...i, [id]: (i[id] ?? 0) + 1 })),
      remove: (id) =>
        setItems((i) => {
          const { [id]: n = 0, ...rest } = i;
          return n > 1 ? { ...rest, [id]: n - 1 } : rest;
        }),
      clear: () => setItems({}),
      count: Object.values(items).reduce((a, b) => a + b, 0),
      total: fromCents(sum),
    };
  }, [items]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCart() {
  const v = useContext(Ctx);
  if (!v) throw new Error("CartProvider missing");
  return v;
}
