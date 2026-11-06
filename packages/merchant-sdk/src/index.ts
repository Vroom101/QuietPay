import { privateKeyToAccount } from "viem/accounts";
import {
  CreateOrderRequest,
  RefundContext,
  Refund,
  RelayRefundRequest,
  ListRefundsResponse,
  buildRefundAuthorization,
  token,
  ErrorResponse,
  Order,
  type ErrorCode,
} from "@quietpay/shared";
import {
  WebhookEvent,
  verifyWebhookSignature,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TOLERANCE_SECONDS,
} from "@quietpay/shared/webhook";

export type { Order, WebhookEvent, Refund, RefundContext };
export { WEBHOOK_SIGNATURE_HEADER };

type Hex = `0x${string}`;

/** Thrown for any non-2xx answer from the relayer. `code` is one of the frozen error codes when present. */
export class QuietpayApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode | "unknown",
    message: string,
  ) {
    super(message);
    this.name = "QuietpayApiError";
  }
}

export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

export interface CreateOrderOptions {
  baseUrl: string;
  apiKey: string;
  merchantId: Hex;
  /** Token base units as a string, e.g. "25000000" for 25 USDT. */
  amount: string;
  reference?: string;
  webhookUrl?: string;
  expiresInSeconds?: number;
  /** Override for tests. Defaults to global fetch. */
  fetch?: typeof fetch;
}

export interface GetOrderOptions {
  baseUrl: string;
  orderId: Hex;
  fetch?: typeof fetch;
}

const trim = (u: string) => u.replace(/\/+$/, "");

async function parse<T>(res: Response, schema: { parse(v: unknown): T }): Promise<T> {
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    throw new QuietpayApiError(res.status, "unknown", `Non-JSON response (${res.status})`);
  }
  if (!res.ok) {
    const e = ErrorResponse.safeParse(json);
    if (e.success) throw new QuietpayApiError(res.status, e.data.error.code, e.data.error.message);
    throw new QuietpayApiError(res.status, "unknown", `Request failed with ${res.status}`);
  }
  return schema.parse(json);
}

/** Creates an order. Call this on your server; the API key must never reach a browser. */
export async function createOrder(opts: CreateOrderOptions): Promise<Order> {
  const body = CreateOrderRequest.parse({
    merchantId: opts.merchantId,
    amount: opts.amount,
    reference: opts.reference,
    webhookUrl: opts.webhookUrl,
    expiresInSeconds: opts.expiresInSeconds,
  });
  const res = await (opts.fetch ?? fetch)(`${trim(opts.baseUrl)}/v1/orders`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
    body: JSON.stringify(body),
  });
  return parse(res, Order);
}

/** Reads an order. Public: no API key needed. */
export async function getOrder(opts: GetOrderOptions): Promise<Order> {
  const res = await (opts.fetch ?? fetch)(`${trim(opts.baseUrl)}/v1/orders/${opts.orderId}`);
  return parse(res, Order);
}

export interface VerifyWebhookOptions {
  secret: string;
  /** The raw request body exactly as received, before any JSON parsing. */
  body: string;
  /** Value of the `Quietpay-Signature` header. */
  signatureHeader: string;
  /** Defaults to 300 seconds. */
  toleranceSeconds?: number;
  /** For tests. */
  nowSeconds?: number;
}

/**
 * Verifies the `Quietpay-Signature` header (`t=<unix>,v1=<hmac>`) and returns the parsed event.
 * Rejects timestamps older than five minutes and compares signatures in constant time.
 * Receivers should ignore events whose `id` they have already processed.
 */
export function verifyWebhook(opts: VerifyWebhookOptions): WebhookEvent {
  if (!opts.signatureHeader) throw new WebhookVerificationError("Missing Quietpay-Signature header");
  const ok = verifyWebhookSignature(opts.secret, opts.body, opts.signatureHeader, {
    toleranceSeconds: opts.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS,
    nowSeconds: opts.nowSeconds,
  });
  if (!ok) throw new WebhookVerificationError("Invalid signature or timestamp outside tolerance");
  let json: unknown;
  try {
    json = JSON.parse(opts.body);
  } catch {
    throw new WebhookVerificationError("Body is not valid JSON");
  }
  const parsed = WebhookEvent.safeParse(json);
  if (!parsed.success) throw new WebhookVerificationError("Body is not a Quietpay event");
  return parsed.data;
}

export interface RefundOptions {
  baseUrl: string;
  apiKey: string;
  merchantId: Hex;
  orderId: Hex;
  router: Hex;
  /** Server-only merchant key. Never place this in a browser or send it to the relayer. */
  refundSignerPrivateKey: Hex;
  /** Base units. Omit to refund the full remaining amount. */
  amount?: string;
  /** Expected sequential index; guards against accidentally refunding twice on an SDK retry. */
  refundIndex: number;
  chainId?: number;
  tokenAddress?: Hex;
  fetch?: typeof fetch;
  nowSeconds?: number;
}

export async function getRefundContext(opts: { baseUrl: string; apiKey: string; orderId: Hex; fetch?: typeof fetch }): Promise<RefundContext> {
  const res = await (opts.fetch ?? fetch)(`${trim(opts.baseUrl)}/v1/orders/${opts.orderId}/refund-context`, {
    headers: { authorization: `Bearer ${opts.apiKey}` },
  });
  return parse(res, RefundContext);
}

export async function getRefund(opts: { baseUrl: string; apiKey: string; refundId: Hex; fetch?: typeof fetch }): Promise<Refund> {
  const res = await (opts.fetch ?? fetch)(`${trim(opts.baseUrl)}/v1/refunds/${opts.refundId}`, {
    headers: { authorization: `Bearer ${opts.apiKey}` },
  });
  return parse(res, Refund);
}

/** Recover a refund ID after an uncertain POST response using the expected index. */
export async function listRefunds(opts: { baseUrl: string; apiKey: string; orderId: Hex; fetch?: typeof fetch }): Promise<Refund[]> {
  const res = await (opts.fetch ?? fetch)(`${trim(opts.baseUrl)}/v1/orders/${opts.orderId}/refunds`, {
    headers: { authorization: `Bearer ${opts.apiKey}` },
  });
  return (await parse(res, ListRefundsResponse)).refunds;
}

/** Signs only the pinned router/token/network and the specified order's refund index. */
export async function refund(opts: RefundOptions): Promise<Refund> {
  const c = await getRefundContext(opts);
  if (c.orderId.toLowerCase() !== opts.orderId.toLowerCase() || c.merchantId.toLowerCase() !== opts.merchantId.toLowerCase()
    || c.router.toLowerCase() !== opts.router.toLowerCase() || c.chainId !== (opts.chainId ?? token.chainId)
    || c.token.toLowerCase() !== (opts.tokenAddress ?? token.address).toLowerCase()
    || c.domain.name !== token.eip712Domain.name || c.domain.version !== token.eip712Domain.version) {
    throw new Error("Refund context does not match the configured merchant, order, router, token or network.");
  }
  if (c.refundIndex !== opts.refundIndex) throw new Error("Refund index changed. Check the original refund status before creating another refund.");
  const account = privateKeyToAccount(opts.refundSignerPrivateKey);
  if (account.address.toLowerCase() !== c.refundSigner.toLowerCase()) throw new Error("Refund key does not match the merchant refundSigner.");
  const amount = opts.amount ?? (BigInt(c.amountPaid) - BigInt(c.refunded)).toString();
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!/^[1-9][0-9]*$/.test(amount) || BigInt(amount) + BigInt(c.refunded) > BigInt(c.amountPaid)) throw new Error("Invalid refund amount.");
  if (BigInt(amount) > BigInt(c.refundBalance)) throw new QuietpayApiError(422, "insufficient_refund_balance", "Fund the merchant refundSigner before refunding.");
  const validAfter = now - 5, validBefore = now + 300;
  const signature = await account.signTypedData(buildRefundAuthorization({
    merchantId: opts.merchantId, orderId: opts.orderId, payer: c.payer as Hex,
    refundSigner: account.address, router: opts.router, amount: BigInt(amount), refundIndex: BigInt(opts.refundIndex),
    validAfter: BigInt(validAfter), validBefore: BigInt(validBefore), chainId: c.chainId, token: c.token as Hex,
  }));
  const body = RelayRefundRequest.parse({ orderId: opts.orderId, amount, refundIndex: opts.refundIndex, validAfter, validBefore, signature });
  const res = await (opts.fetch ?? fetch)(`${trim(opts.baseUrl)}/v1/relay/refund`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` }, body: JSON.stringify(body),
  });
  return parse(res, Refund);
}
