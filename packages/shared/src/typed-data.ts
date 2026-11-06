import {
  encodeAbiParameters,
  keccak256,
  parseAbiParameters,
  recoverTypedDataAddress,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import tokenJson from "../token.json";

export const token = tokenJson;

/** keccak256("quietpay.pay.v1") */
export const PAY_TAG = keccak256(stringToHex("quietpay.pay.v1"));
/** validBefore may be at most this many seconds after validAfter. */
export const MAX_AUTH_WINDOW_SECONDS = 600;

export const RECEIVE_WITH_AUTHORIZATION_TYPES = {
  ReceiveWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/** merchantId is keccak256 of a human slug, e.g. "demo-store". */
export function merchantIdFromSlug(slug: string): Hex {
  return keccak256(stringToHex(slug));
}

/** Must match PaymentRouter.computeNonce. */
export function computePayNonce(args: {
  merchantId: Hex;
  orderId: Hex;
  payout: Address;
  value: bigint;
}): Hex {
  return keccak256(
    encodeAbiParameters(parseAbiParameters("bytes32, bytes32, bytes32, address, uint256"), [
      PAY_TAG,
      args.merchantId,
      args.orderId,
      args.payout,
      args.value,
    ]),
  );
}

export function tokenDomain(args?: { chainId?: number; token?: Address; name?: string; version?: string }) {
  return {
    name: args?.name ?? token.eip712Domain.name,
    version: args?.version ?? token.eip712Domain.version,
    chainId: args?.chainId ?? token.chainId,
    verifyingContract: (args?.token ?? token.address) as Address,
  };
}

export interface CheckoutAuthorizationInput {
  from: Address;
  router: Address;
  value: bigint;
  nonce: Hex;
  validAfter: bigint;
  validBefore: bigint;
  chainId?: number;
  token?: Address;
  domainName?: string;
  domainVersion?: string;
}

/**
 * Typed data the payer signs. Always ReceiveWithAuthorization with `to` = router.
 * transferWithAuthorization is never used for checkout.
 */
export function buildCheckoutAuthorization(i: CheckoutAuthorizationInput) {
  return {
    domain: tokenDomain({
      chainId: i.chainId,
      token: i.token,
      name: i.domainName,
      version: i.domainVersion,
    }),
    types: RECEIVE_WITH_AUTHORIZATION_TYPES,
    primaryType: "ReceiveWithAuthorization" as const,
    message: {
      from: i.from,
      to: i.router,
      value: i.value,
      validAfter: i.validAfter,
      validBefore: i.validBefore,
      nonce: i.nonce,
    },
  };
}

export function recoverCheckoutSigner(
  input: CheckoutAuthorizationInput,
  signature: Hex,
): Promise<Address> {
  const td = buildCheckoutAuthorization(input);
  return recoverTypedDataAddress({ ...td, signature });
}

/** Returns an error string if the validity window breaks the router's rules, else null. */
export function checkAuthWindow(validAfter: number, validBefore: number, nowSeconds: number): string | null {
  if (validBefore <= validAfter) return "validBefore must be after validAfter";
  if (validBefore - validAfter > MAX_AUTH_WINDOW_SECONDS) return "window longer than 10 minutes";
  if (nowSeconds <= validAfter) return "authorization not yet valid";
  if (nowSeconds >= validBefore) return "authorization expired";
  return null;
}

/** Format base units (6 decimals) for display, e.g. 25000000n -> "25.00". */
export function formatUsdt(value: bigint | string, decimals: number = token.decimals): string {
  const v = BigInt(value);
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, "0").slice(0, 2);
  return `${whole.toString()}.${frac}`;
}

export function parseUsdt(amount: string): bigint {
  const [w, f = ""] = amount.split(".");
  return BigInt(w || "0") * 10n ** BigInt(token.decimals) + BigInt(f.padEnd(token.decimals, "0").slice(0, token.decimals));
}

/** Refund nonces bind the original payer, order, amount and sequential refund index. */
export const REFUND_TAG = keccak256(stringToHex("quietpay.refund.v1"));
export function computeRefundNonce(args: { merchantId: Hex; orderId: Hex; payer: Address; amount: bigint; refundIndex: bigint }): Hex {
  return keccak256(encodeAbiParameters(parseAbiParameters("bytes32, bytes32, bytes32, address, uint256, uint256"),
    [REFUND_TAG, args.merchantId, args.orderId, args.payer, args.amount, args.refundIndex]));
}

export function buildRefundAuthorization(args: {
  merchantId: Hex; orderId: Hex; payer: Address; refundSigner: Address; router: Address;
  amount: bigint; refundIndex: bigint; validAfter: bigint; validBefore: bigint;
  chainId?: number; token?: Address; domainName?: string; domainVersion?: string;
}) {
  return buildCheckoutAuthorization({ ...args, from: args.refundSigner, value: args.amount,
    nonce: computeRefundNonce(args) });
}
