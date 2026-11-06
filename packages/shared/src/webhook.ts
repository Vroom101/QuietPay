import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { Address, Amount, Bytes32, TxHash } from "./schemas.js";

export const WEBHOOK_EVENT_TYPES = ["payment.settled", "payment.failed", "payment.refunded"] as const;
export const WebhookEventType = z.enum(WEBHOOK_EVENT_TYPES);
export type WebhookEventType = z.infer<typeof WebhookEventType>;

/** Each event has a unique `id` so receivers can ignore duplicates. */
export const WebhookEvent = z.object({
  id: z.string().min(8),
  type: WebhookEventType,
  createdAt: z.number().int(),
  data: z.object({
    orderId: Bytes32,
    merchantId: Bytes32,
    amount: Amount,
    fee: Amount.or(z.literal("0")),
    payer: Address.optional(),
    payout: Address,
    txHash: TxHash.optional(),
    reference: z.string().optional(),
    failureCode: z.string().optional(),
    refundId: Bytes32.optional(),
    refundAmount: Amount.optional(),
    totalRefunded: Amount.or(z.literal("0")).optional(),
    refundIndex: z.number().int().nonnegative().optional(),
  }),
}).superRefine((event, ctx) => {
  if (event.type !== "payment.refunded") return;
  for (const field of ["refundId", "refundAmount", "totalRefunded", "refundIndex"] as const) {
    if (event.data[field] === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["data", field], message: "Refund event field required" });
  }
});
export type WebhookEvent = z.infer<typeof WebhookEvent>;

export const WEBHOOK_SIGNATURE_HEADER = "Quietpay-Signature";
export const WEBHOOK_TOLERANCE_SECONDS = 300;
/** Upper bound for a caller-supplied tolerance (one day). */
export const WEBHOOK_MAX_TOLERANCE_SECONDS = 86400;

/** A replay tolerance must be a finite number in (0, WEBHOOK_MAX_TOLERANCE_SECONDS]. NaN and Infinity never pass. */
export function isValidWebhookTolerance(tol: number): boolean {
  return Number.isFinite(tol) && tol > 0 && tol <= WEBHOOK_MAX_TOLERANCE_SECONDS;
}

/** Header format: `t=<unix seconds>,v1=<hex HMAC-SHA256 of t + "." + body>` */
export function computeWebhookSignature(secret: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export function signWebhook(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)): string {
  return `t=${timestamp},v1=${computeWebhookSignature(secret, timestamp, body)}`;
}

export function parseSignatureHeader(header: string): { t: number; v1: string[] } | null {
  const parts = header.split(",").map((p) => p.trim());
  let t: number | null = null;
  const v1: string[] = [];
  for (const p of parts) {
    const i = p.indexOf("=");
    if (i < 0) continue;
    const k = p.slice(0, i);
    const val = p.slice(i + 1);
    if (k === "t" && /^[0-9]+$/.test(val)) t = Number(val);
    if (k === "v1" && /^[0-9a-fA-F]{64}$/.test(val)) v1.push(val.toLowerCase());
  }
  return t === null || v1.length === 0 ? null : { t, v1 };
}

export function verifyWebhookSignature(
  secret: string,
  body: string,
  header: string,
  opts?: { nowSeconds?: number; toleranceSeconds?: number },
): boolean {
  // An empty (or whitespace-only) secret is a public HMAC key: never verify against it.
  if (secret.trim() === "") return false;
  const parsed = parseSignatureHeader(header);
  if (!parsed) return false;
  const now = opts?.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tol = opts?.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS;
  // R8-W1: a NaN/Infinity/zero/negative tolerance would disable or break the freshness check. Fail closed.
  if (!isValidWebhookTolerance(tol)) return false;
  if (!Number.isFinite(now) || Math.abs(now - parsed.t) > tol) return false;
  const expected = Buffer.from(computeWebhookSignature(secret, parsed.t, body), "hex");
  return parsed.v1.some((sig) => {
    const got = Buffer.from(sig, "hex");
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}
