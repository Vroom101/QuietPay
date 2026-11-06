import { ERROR_CODES, ERROR_USER_MESSAGES, type ErrorCode } from "@quietpay/shared";

export const GENERIC_MESSAGE = "Something went wrong on our side. Please try again in a moment.";
export const NETWORK_MESSAGE = "We could not reach the payment service. Please check your connection and try again.";
export const TIMEOUT_MESSAGE = "This is taking longer than expected. Please check back in a moment; you will not be charged twice.";

/** Shown when the widget refuses to sign because the relayer's payment details do not match what was expected. */
export const CHECKOUT_MISMATCH_MESSAGE =
  "We stopped this payment because its details did not match this shop's checkout. Nothing was signed and no money moved. Please contact the shop.";
/** Shown when a wallet saved in this browser exists but cannot be opened. It is never replaced automatically. */
export const WALLET_UNREADABLE_MESSAGE =
  "We could not open the payment wallet saved in this browser. To keep any funds in it safe, we did not replace it. Please contact the shop for help restoring it from a backup.";

/** Codes the widget produces itself when it refuses to sign (see verifyCheckout). */
export function isCheckoutRefusal(code: unknown): boolean {
  return typeof code === "string" && code.startsWith("checkout_");
}

export function isErrorCode(code: unknown): code is ErrorCode {
  return typeof code === "string" && (ERROR_CODES as readonly string[]).includes(code);
}

/** Plain-words text for any relayer error code; unknown codes get a generic message. */
export function messageForCode(code: string | undefined): string {
  if (isCheckoutRefusal(code)) return CHECKOUT_MISMATCH_MESSAGE;
  if (code === "wallet_unreadable") return WALLET_UNREADABLE_MESSAGE;
  return isErrorCode(code) ? ERROR_USER_MESSAGES[code] : GENERIC_MESSAGE;
}
