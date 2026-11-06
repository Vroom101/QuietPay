import { ERROR_CODES, ERROR_USER_MESSAGES, type ErrorCode } from "@quietpay/shared";

export const GENERIC_MESSAGE = "Something went wrong on our side. Please try again in a moment.";
export const NETWORK_MESSAGE = "We could not reach the payment service. Please check your connection and try again.";
export const TIMEOUT_MESSAGE = "This is taking longer than expected. Please check back in a moment; you will not be charged twice.";

export function isErrorCode(code: unknown): code is ErrorCode {
  return typeof code === "string" && (ERROR_CODES as readonly string[]).includes(code);
}

/** Plain-words text for any relayer error code; unknown codes get a generic message. */
export function messageForCode(code: string | undefined): string {
  return isErrorCode(code) ? ERROR_USER_MESSAGES[code] : GENERIC_MESSAGE;
}
