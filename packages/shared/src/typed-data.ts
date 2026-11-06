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

/** keccak256("quietpay.pay.v2"). v2 binds the relay fee into the nonce. */
export const PAY_TAG = keccak256(stringToHex("quietpay.pay.v2"));
/** keccak256("quietpay.refund.v1") */
export const REFUND_TAG = keccak256(stringToHex("quietpay.refund.v1"));
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

/**
 * Must match PaymentRouter.computeNonce: keccak256(abi.encode(PAY_TAG, merchantId, orderId, payout, value, fee)).
 * `fee` is required with no default: the payer signs the exact fee they were quoted, and the router recomputes the
 * nonce from the fee the relayer submits, so a different fee makes the token reject the signature.
 */
export function computePayNonce(args: {
  merchantId: Hex;
  orderId: Hex;
  payout: Address;
  value: bigint;
  fee: bigint;
}): Hex {
  return keccak256(
    encodeAbiParameters(parseAbiParameters("bytes32, bytes32, bytes32, address, uint256, uint256"), [
      PAY_TAG,
      args.merchantId,
      args.orderId,
      args.payout,
      args.value,
      args.fee,
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

/** Must match PaymentRouter.computeRefundNonce. `payer` comes from the receipt, never from the caller. */
export function computeRefundNonce(args: {
  merchantId: Hex;
  orderId: Hex;
  payer: Address;
  amount: bigint;
  refundIndex: bigint | number;
}): Hex {
  return keccak256(
    encodeAbiParameters(parseAbiParameters("bytes32, bytes32, bytes32, address, uint256, uint256"), [
      REFUND_TAG,
      args.merchantId,
      args.orderId,
      args.payer,
      args.amount,
      BigInt(args.refundIndex),
    ]),
  );
}

export interface RefundAuthorizationInput extends Omit<CheckoutAuthorizationInput, "from" | "value"> {
  /** The merchant's refundSigner wallet. It signs; the router forwards to the stored payer. */
  refundSigner: Address;
  /** Refund amount in token base units. */
  amount: bigint;
}

/** Same ReceiveWithAuthorization shape as checkout: from = refundSigner, to = router, value = refund amount. */
export function buildRefundAuthorization(i: RefundAuthorizationInput | (Omit<RefundAuthorizationInput, "nonce"> & {
  merchantId: Hex; orderId: Hex; payer: Address; refundIndex: bigint | number;
})) {
  const { refundSigner, amount, ...rest } = i;
  return buildCheckoutAuthorization({ ...rest, nonce: "nonce" in i ? i.nonce : computeRefundNonce(i), from: refundSigner, value: amount });
}

export function recoverRefundSigner(input: RefundAuthorizationInput, signature: Hex): Promise<Address> {
  return recoverTypedDataAddress({ ...buildRefundAuthorization(input), signature });
}
