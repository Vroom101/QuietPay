import {
  ErrorResponse,
  GetOrderResponse,
  RelayPayResponse,
  buildCheckoutAuthorization,
  computePayNonce,
  deployments,
  tokenDomain,
  type Order,
  type RelayPayRequest,
} from "@quietpay/shared";
import type { PrivateKeyAccount } from "viem/accounts";
import { NETWORK_MESSAGE } from "./messages.js";

/** Error carrying a relayer code (or "network"/"timeout"/"unknown") for the UI to map to plain words. */
export class WidgetError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "WidgetError";
  }
}

const trim = (u: string) => u.replace(/\/+$/, "");

async function request(url: string, init?: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new WidgetError("network", NETWORK_MESSAGE);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  if (!res.ok) {
    const parsed = ErrorResponse.safeParse(body);
    if (parsed.success) throw new WidgetError(parsed.data.error.code, parsed.data.error.message);
    throw new WidgetError("unknown", "unknown error");
  }
  return body;
}

export async function fetchOrder(relayerUrl: string, orderId: string): Promise<Order> {
  const body = await request(`${trim(relayerUrl)}/v1/orders/${orderId}`);
  const parsed = GetOrderResponse.safeParse(body);
  if (!parsed.success) throw new WidgetError("unknown", "malformed order");
  if (parsed.data.id.toLowerCase() !== orderId.toLowerCase()) {
    throw new WidgetError("payment_details_changed", "unexpected order ID");
  }
  return parsed.data;
}

export async function relayPay(relayerUrl: string, req: RelayPayRequest) {
  const body = await request(`${trim(relayerUrl)}/v1/relay/pay`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
  });
  const parsed = RelayPayResponse.safeParse(body);
  if (!parsed.success) throw new WidgetError("unknown", "malformed response");
  return parsed.data;
}

interface CheckoutExpectations {
  router?: string;
  amount?: string;
  reviewedOrder?: Order;
}

/** Builds and signs the single ReceiveWithAuthorization the payer approves. */
export async function signCheckout(
  account: PrivateKeyAccount,
  order: Order,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  expected: CheckoutExpectations = {},
): Promise<RelayPayRequest> {
  const domain = tokenDomain();
  const router = expected.router ?? deployments[String(domain.chainId)]?.router;
  const c = order.checkout;
  const reviewed = expected.reviewedOrder;
  if (
    !router || c.router.toLowerCase() !== router.toLowerCase() ||
    c.chainId !== domain.chainId || c.token.toLowerCase() !== domain.verifyingContract.toLowerCase() ||
    c.domain.name !== domain.name || c.domain.version !== domain.version ||
    c.value !== order.amount || order.amount !== (expected.amount ?? reviewed?.amount ?? order.amount) ||
    c.payout.toLowerCase() !== order.payout.toLowerCase() ||
    (reviewed && (
      order.id.toLowerCase() !== reviewed.id.toLowerCase() ||
      order.amount !== reviewed.amount ||
      order.merchantId.toLowerCase() !== reviewed.merchantId.toLowerCase() ||
      order.payout.toLowerCase() !== reviewed.payout.toLowerCase()
    ))
  ) {
    throw new WidgetError("payment_details_changed", "checkout details differ from the expected order");
  }

  const value = BigInt(c.value);
  if (value <= 0n || value >= 2n ** 256n) {
    throw new WidgetError("payment_details_changed", "invalid checkout amount");
  }
  const nonce = computePayNonce({
    merchantId: order.merchantId as `0x${string}`,
    orderId: order.id as `0x${string}`,
    payout: order.payout as `0x${string}`,
    value,
  });
  if (c.nonce.toLowerCase() !== nonce.toLowerCase()) {
    throw new WidgetError("payment_details_changed", "unexpected checkout nonce");
  }

  const validAfter = nowSeconds - 5;
  const validBefore = nowSeconds + 300;
  const td = buildCheckoutAuthorization({
    from: account.address,
    router: c.router as `0x${string}`,
    value,
    nonce,
    validAfter: BigInt(validAfter),
    validBefore: BigInt(validBefore),
    chainId: c.chainId,
    token: c.token as `0x${string}`,
    domainName: c.domain.name,
    domainVersion: c.domain.version,
  });
  const signature = await account.signTypedData(td);
  return { orderId: order.id, payer: account.address, validAfter, validBefore, signature, amount: order.amount };
}

export interface PollOptions {
  intervalMs?: number;
  timeoutMs?: number;
  onUpdate?: (o: Order) => void;
}

/** Polls until the order is settled / failed / expired. Throws WidgetError("timeout") after the timeout. */
export async function pollOrder(relayerUrl: string, orderId: string, opts: PollOptions = {}): Promise<Order> {
  const interval = opts.intervalMs ?? 1000;
  const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
  for (;;) {
    const o = await fetchOrder(relayerUrl, orderId);
    opts.onUpdate?.(o);
    if (o.status === "settled" || o.status === "failed" || o.status === "expired") return o;
    if (Date.now() >= deadline) throw new WidgetError("timeout", "timeout");
    await new Promise((r) => setTimeout(r, interval));
  }
}
