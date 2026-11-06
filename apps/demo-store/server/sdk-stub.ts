/**
 * Local stand-in for `@quietpay/merchant-sdk`, implementing the FROZEN interface:
 *   createOrder(opts) / getOrder(opts) / verifyWebhook(opts)
 * Used only because the real package is not present in this worktree.
 * Switch to the real SDK by changing the single import line in server/index.ts.
 * Node-only (uses the shared webhook helpers, which use node:crypto).
 */
import { GetOrderResponse, CreateOrderResponse, ErrorResponse, type Order } from "@quietpay/shared";
import {
  WebhookEvent,
  verifyWebhookSignature,
  WEBHOOK_TOLERANCE_SECONDS,
} from "@quietpay/shared/webhook";

export type { Order, WebhookEvent };

const trim = (u: string) => u.replace(/\/+$/, "");

async function parse<T>(res: Response, schema: { parse(v: unknown): T }): Promise<T> {
  const body = (await res.json().catch(() => undefined)) as unknown;
  if (!res.ok) {
    const e = ErrorResponse.safeParse(body);
    throw new Error(e.success ? `${e.data.error.code}: ${e.data.error.message}` : `relayer returned ${res.status}`);
  }
  return schema.parse(body);
}

export async function createOrder(opts: {
  baseUrl: string;
  apiKey: string;
  merchantId: `0x${string}`;
  amount: string;
  reference?: string;
  webhookUrl?: string;
  expiresInSeconds?: number;
}): Promise<Order> {
  const { baseUrl, apiKey, ...body } = opts;
  const res = await fetch(`${trim(baseUrl)}/v1/orders`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  return parse(res, CreateOrderResponse);
}

export async function getOrder(opts: { baseUrl: string; orderId: `0x${string}` }): Promise<Order> {
  const res = await fetch(`${trim(opts.baseUrl)}/v1/orders/${opts.orderId}`);
  return parse(res, GetOrderResponse);
}

/** Throws on a bad signature or a stale timestamp. */
export function verifyWebhook(opts: {
  secret: string;
  body: string;
  signatureHeader: string;
  toleranceSeconds?: number;
}): WebhookEvent {
  const ok = verifyWebhookSignature(opts.secret, opts.body, opts.signatureHeader, {
    toleranceSeconds: opts.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS,
  });
  if (!ok) throw new Error("invalid webhook signature");
  return WebhookEvent.parse(JSON.parse(opts.body));
}
