import { parseUsdt } from "@quietpay/shared";
// The product list is compiled into the server bundle. Prices are read from this module, never from the request.
import { PRODUCTS } from "../src/products.js";

/** Server-side price list: product id -> price in token base units. */
export const CATALOG: ReadonlyMap<string, bigint> = new Map(PRODUCTS.map((p) => [p.id, parseUsdt(p.price)]));

export const MAX_QUANTITY_PER_ITEM = 99;
export const MAX_LINE_ITEMS = 50;

export interface CartLine {
  id: string;
  quantity: number;
}

export class CartError extends Error {}

/**
 * Validates `{ items: [{ id, quantity }] }` from the browser and prices it with the SERVER's catalog.
 * The browser only says WHAT it wants and HOW MANY; it never says what it costs.
 * Throws CartError with a client-safe message on any invalid input.
 */
export function priceCart(input: unknown): { lines: CartLine[]; total: bigint } {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    input = Object.entries(input).map(([id, quantity]) => ({ id, quantity }));
  }
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_LINE_ITEMS) {
    throw new CartError(`items must be a non-empty array of at most ${MAX_LINE_ITEMS} { id, quantity } entries`);
  }
  const qty = new Map<string, number>();
  for (const line of input as unknown[]) {
    if (typeof line !== "object" || line === null || Array.isArray(line)) throw new CartError("each item must be { id, quantity }");
    const { id, quantity } = line as { id?: unknown; quantity?: unknown };
    if (typeof id !== "string" || !CATALOG.has(id)) throw new CartError("unknown product id");
    if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY_PER_ITEM) {
      throw new CartError(`quantity must be an integer from 1 to ${MAX_QUANTITY_PER_ITEM}`);
    }
    const merged = (qty.get(id) ?? 0) + quantity;
    if (merged > MAX_QUANTITY_PER_ITEM) throw new CartError(`quantity must be an integer from 1 to ${MAX_QUANTITY_PER_ITEM}`);
    qty.set(id, merged);
  }
  let total = 0n;
  const lines: CartLine[] = [];
  for (const [id, quantity] of qty) {
    total += CATALOG.get(id)! * BigInt(quantity);
    lines.push({ id, quantity });
  }
  return { lines, total };
}
