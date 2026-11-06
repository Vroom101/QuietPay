import {
  ErrorResponse,
  ListOrdersResponse,
  MerchantRefundView,
  MerchantRefundOperation,
  type Order,
} from "@quietpay/shared";
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
  const id = (n: number) =>
    ("0x" + n.toString(16).padStart(64, "0")) as `0x${string}`;
  const base = orderSettled.createdAt;
  const sample = ({ checkout: _checkout, ...order }: Order, number: number) =>
    makeOrder({ ...order, id: id(number), reference: `order-${1040 + number}` });
  return [
    { ...orderSettled, status: "partially_refunded" as const, refunded: "10000000", refundCount: 1 },
    sample(orderPending, 1),
    sample(orderCreated, 2),
    sample(orderFailed, 3),
    makeOrder({
      id: id(9),
      status: "refunded",
      payer: FIXTURE_PAYER,
      amount: "8500000",
      refunded: "8500000",
      refundCount: 1,
      reference: "order-1044",
      createdAt: base + 2 * 86400,
      settledAt: base + 2 * 86400 + 10,
    }),
    sample(orderExpired, 5),
    makeOrder({
      id: id(7),
      amount: "125500000",
      fee: "50000",
      refunded: "0",
      refundCount: 0,
      status: "settled",
      payer: FIXTURE_PAYER,
      txHash: ("0x" + "ef".repeat(32)) as `0x${string}`,
      explorerUrl: "https://sepolia.whitechain.io/tx/0x" + "ef".repeat(32),
      createdAt: base + 86400,
      settledAt: base + 86410,
      reference: "order-1042",
    }),
  ].sort((a, b) => b.createdAt - a.createdAt);
}

export class DashboardError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface ListOptions {
  relayerUrl?: string;
  merchantUrl?: string;
  apiKey: string;
  useFixtures?: boolean;
}

export async function listOrders(opts: ListOptions): Promise<Order[]> {
  if (opts.useFixtures) return fixtureOrders();
  if (!opts.apiKey)
    throw new DashboardError(
      "Enter your dashboard access token to load orders.",
    );
  if (opts.merchantUrl)
    return (
      await merchantRequest(
        { merchantUrl: opts.merchantUrl, apiKey: opts.apiKey },
        "/orders",
        ListOrdersResponse,
      )
    ).orders;
  let res: Response;
  try {
    res = await fetch(
      opts.merchantUrl
        ? `${opts.merchantUrl.replace(/\/+$/, "")}/orders`
        : `${opts.relayerUrl!.replace(/\/+$/, "")}/v1/orders`,
      {
        headers: { authorization: `Bearer ${opts.apiKey}` },
      },
    );
  } catch {
    throw new DashboardError("Could not reach the relayer.");
  }
  const body = (await res.json().catch(() => undefined)) as unknown;
  if (res.status === 401 || res.status === 403)
    throw new DashboardError("The dashboard access token was not accepted.");
  if (!res.ok) {
    const e = ErrorResponse.safeParse(body);
    throw new DashboardError(
      e.success
        ? e.data.error.message
        : `The relayer returned an error (${res.status}).`,
    );
  }
  const parsed = ListOrdersResponse.safeParse(body);
  if (!parsed.success)
    throw new DashboardError("The relayer sent an unexpected response.");
  return parsed.data.orders;
}

export interface MerchantOptions {
  merchantUrl: string;
  apiKey: string;
}
async function merchantRequest<T>(
  options: MerchantOptions,
  path: string,
  schema: { parse(value: unknown): T },
  payload?: unknown,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(
      `${options.merchantUrl.replace(/\/+$/, "")}${path}`,
      {
        method: payload ? "POST" : "GET",
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          ...(payload ? { "content-type": "application/json" } : {}),
        },
        body: payload ? JSON.stringify(payload) : undefined,
        signal: AbortSignal.timeout(15000),
      },
    );
  } catch {
    throw new DashboardError(
      "Could not confirm the request. Refresh status or check the original request before continuing.",
    );
  }
  const body = (await response.json().catch(() => undefined)) as
    { error?: { message?: string; code?: string } } | undefined;
  if (response.status === 401 || response.status === 403)
    throw new DashboardError("The dashboard access token was not accepted.", body?.error?.code, response.status);
  if (!response.ok)
    throw new DashboardError(
      body?.error?.message ??
        `Merchant server returned HTTP ${response.status}.`,
      body?.error?.code,
      response.status,
    );
  try {
    return schema.parse(body);
  } catch {
    throw new DashboardError(
      "Merchant server returned an unexpected refund response. Refresh status before continuing.",
    );
  }
}
export const getMerchantRefundView = (
  options: MerchantOptions,
  orderId: string,
) =>
  merchantRequest(
    options,
    `/orders/${encodeURIComponent(orderId)}/refund-context`,
    MerchantRefundView,
  );
export const submitMerchantRefund = (
  options: MerchantOptions,
  orderId: string,
  body: { requestId: string; amount: string; refundIndex: number },
) =>
  merchantRequest(
    options,
    `/orders/${encodeURIComponent(orderId)}/refunds`,
    MerchantRefundOperation,
    body,
  );
