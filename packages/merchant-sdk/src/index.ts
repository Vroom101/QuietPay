import {
  CreateOrderRequest,
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

export type { Order, WebhookEvent };
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

/**
 * Refunds are a P1 feature. This stub fixes the call shape so merchants can code against it;
 * it always throws until refunds ship.
 */
export interface RefundOptions {
  baseUrl: string;
  apiKey: string;
  orderId: Hex;
  /** Base units. Omit for a full refund. */
  amount?: string;
}

export async function refund(_opts: RefundOptions): Promise<never> {
  throw new Error("refund() is not implemented yet. Refunds ship in P1.");
}
