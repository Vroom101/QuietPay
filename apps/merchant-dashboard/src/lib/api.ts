import { ErrorResponse, ListOrdersResponse, type Order } from "@quietpay/shared";
import {
  FIXTURE_PAYER,
  makeOrder,
  orderCreated,
  orderExpired,
  orderFailed,
  orderPending,
  orderSettled,
} from "@quietpay/shared/fixtures";

/** Local stand-in for GET /v1/orders (the mock relayer does not serve it). Toggled by VITE_USE_FIXTURES=1. */
export function fixtureOrders(): Order[] {
  const id = (n: number) => ("0x" + n.toString(16).padStart(64, "0")) as `0x${string}`;
  const base = orderSettled.createdAt;
  return [
    orderSettled,
    orderPending,
    orderCreated,
    orderFailed,
    orderExpired,
    makeOrder({
      id: id(7),
      amount: "125500000",
      fee: "50000",
      status: "settled",
      payer: FIXTURE_PAYER,
      txHash: ("0x" + "ef".repeat(32)) as `0x${string}`,
      explorerUrl: "https://sepolia.whitechain.io/tx/0x" + "ef".repeat(32),
      createdAt: base + 3600,
      settledAt: base + 3610,
      reference: "order-1042",
    }),
  ].sort((a, b) => b.createdAt - a.createdAt);
}

export class DashboardError extends Error {}

export interface ListOptions {
  relayerUrl: string;
  apiKey: string;
  useFixtures?: boolean;
}

export async function listOrders(opts: ListOptions): Promise<Order[]> {
  if (opts.useFixtures) return fixtureOrders();
  if (!opts.apiKey) throw new DashboardError("Enter your API key to load orders.");
  let res: Response;
  try {
    res = await fetch(`${opts.relayerUrl.replace(/\/+$/, "")}/v1/orders`, {
      headers: { authorization: `Bearer ${opts.apiKey}` },
    });
  } catch {
    throw new DashboardError("Could not reach the relayer.");
  }
  const body = (await res.json().catch(() => undefined)) as unknown;
  if (res.status === 401 || res.status === 403) throw new DashboardError("The API key was not accepted.");
  if (!res.ok) {
    const e = ErrorResponse.safeParse(body);
    throw new DashboardError(e.success ? e.data.error.message : `The relayer returned an error (${res.status}).`);
  }
  const parsed = ListOrdersResponse.safeParse(body);
  if (!parsed.success) throw new DashboardError("The relayer sent an unexpected response.");
  return parsed.data.orders;
}
