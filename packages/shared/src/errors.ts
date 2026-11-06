import { z } from "zod";

/** Frozen relayer error codes (P0). Do not rename; add new codes only via shared-change. */
export const ERROR_CODES = [
  "order_not_found",
  "order_expired",
  "bad_signature",
  "amount_mismatch",
  "already_settled",
  "relayer_paused",
  "rate_limited",
  "simulation_failed",
  "fee_over_cap",
] as const;

export const ErrorCode = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ErrorResponse = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
  }),
});
export type ErrorResponse = z.infer<typeof ErrorResponse>;

/** HTTP status the relayer uses for each code. */
export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  order_not_found: 404,
  order_expired: 410,
  bad_signature: 400,
  amount_mismatch: 400,
  already_settled: 409,
  relayer_paused: 503,
  rate_limited: 429,
  simulation_failed: 422,
  fee_over_cap: 422,
};

/** Plain-words text for end users. Never mentions gas, WBT or transactions. */
export const ERROR_USER_MESSAGES: Record<ErrorCode, string> = {
  order_not_found: "We could not find this order. Please go back to the store and start again.",
  order_expired: "This payment link has expired. Please go back to the store and start again.",
  bad_signature: "We could not confirm your approval. Please try again.",
  amount_mismatch: "The amount changed since you started. Please go back and check the price.",
  already_settled: "This order has already been paid. You have not been charged twice.",
  relayer_paused: "Payments are paused for a moment. Please try again shortly.",
  rate_limited: "Too many attempts. Please wait a minute and try again.",
  simulation_failed: "This payment could not go through, and you have not been charged. Please check your balance and try again.",
  fee_over_cap: "This payment could not be processed right now, and you have not been charged. Please try again later.",
};

export function errorBody(code: ErrorCode, message?: string): ErrorResponse {
  return { error: { code, message: message ?? ERROR_USER_MESSAGES[code] } };
}

export class QuietpayError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message?: string,
  ) {
    super(message ?? ERROR_USER_MESSAGES[code]);
    this.name = "QuietpayError";
  }
  get status(): number {
    return ERROR_HTTP_STATUS[this.code];
  }
  toBody(): ErrorResponse {
    return errorBody(this.code, this.message);
  }
}
