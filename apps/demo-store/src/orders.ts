const storageKey = "quietpay-store-orders";

interface OrderSummary {
  total: string;
  placedAt: number;
  items: { name: string; quantity: number }[];
}

export interface StoreOrder {
  paymentId: string;
  summary?: OrderSummary;
}

let recent: StoreOrder[] = [];

export function listOrders(): StoreOrder[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
    if (Array.isArray(saved)) {
      return saved.flatMap((entry): StoreOrder[] => {
        if (typeof entry === "string") return [{ paymentId: entry }];
        return entry && typeof entry.paymentId === "string" ? [entry as StoreOrder] : [];
      });
    }
  } catch {
    // Fall back to orders from this session if storage is unavailable.
  }
  return recent;
}

export function rememberOrder(paymentId: string, summary: OrderSummary) {
  recent = [{ paymentId, summary }, ...listOrders().filter((order) => order.paymentId !== paymentId)].slice(0, 25);
  try {
    localStorage.setItem(storageKey, JSON.stringify(recent));
  } catch {
    // The order remains available in this session.
  }
}
