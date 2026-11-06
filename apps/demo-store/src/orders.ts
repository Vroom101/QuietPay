const storageKey = "quietpay-store-orders";
let recent: string[] = [];

export function listOrderIds(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
    if (Array.isArray(value)) return value.filter((id): id is string => typeof id === "string");
  } catch {
    // Fall back to orders from this session if storage is unavailable.
  }
  return recent;
}

export function rememberOrder(id: string) {
  recent = [id, ...listOrderIds().filter((other) => other !== id)].slice(0, 25);
  try {
    localStorage.setItem(storageKey, JSON.stringify(recent));
  } catch {
    // The order remains available in this session.
  }
}
