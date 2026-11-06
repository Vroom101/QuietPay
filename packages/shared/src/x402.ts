import { z } from "zod";
import { type Address as EvmAddress, type Hex } from "viem";
import { Address, Bytes32, Signature, Amount, TxHash } from "./schemas.js";
import { tokenDomain } from "./typed-data.js";

const uint = z
  .string()
  .max(78)
  .regex(/^(0|[1-9][0-9]*)$/)
  .refine((v) => BigInt(v) < 2n ** 256n, "uint256 overflow");
export const X402Resource = z.object({
  url: z
    .string()
    .max(2048)
    .url()
    .refine((v) => {
      const u = new URL(v);
      return (
        ["http:", "https:"].includes(u.protocol) &&
        !u.username &&
        !u.password &&
        !u.hash
      );
    }, "HTTP(S) resource required"),
  description: z.string().max(256).optional(),
  mimeType: z.string().max(128).optional(),
});
export const X402Requirements = z.object({
  scheme: z.literal("exact"),
  network: z.string().regex(/^eip155:[1-9][0-9]*$/),
  asset: Address,
  amount: Amount.max(78).refine((v) => BigInt(v) < 2n ** 256n),
  payTo: Address,
  maxTimeoutSeconds: z.number().int().min(1).max(600),
  extra: z.object({
    name: z.string().min(1).max(128),
    version: z.string().min(1).max(32),
    assetTransferMethod: z.literal("eip3009").optional(),
    paymentFlow: z.literal("upfront").optional(),
  }),
});
export type X402Requirements = z.infer<typeof X402Requirements>;
export const X402Authorization = z.object({
  from: Address,
  to: Address,
  value: Amount.max(78).refine((v) => BigInt(v) < 2n ** 256n),
  validAfter: uint,
  validBefore: uint,
  nonce: Bytes32,
});
export type X402Authorization = z.infer<typeof X402Authorization>;
export const X402Payload = z.object({
  x402Version: z.literal(2),
  resource: X402Resource,
  accepted: X402Requirements,
  payload: z.object({ signature: Signature, authorization: X402Authorization }),
  extensions: z
    .record(z.unknown())
    .refine((v) => Object.keys(v).length === 0, "Extensions are not supported")
    .optional(),
});
export type X402Payload = z.infer<typeof X402Payload>;
export const X402Required = z.object({
  x402Version: z.literal(2),
  error: z.string().optional(),
  resource: X402Resource,
  accepts: z.array(X402Requirements).min(1),
  extensions: z.record(z.unknown()).optional(),
});
export type X402Required = z.infer<typeof X402Required>;
export const FacilitatorRequest = z.object({
  x402Version: z.literal(2),
  paymentPayload: X402Payload,
  paymentRequirements: X402Requirements,
});
export type FacilitatorRequest = z.infer<typeof FacilitatorRequest>;
export const X402VerifyResponse = z.object({
  isValid: z.boolean(),
  invalidReason: z.string().optional(),
  payer: Address.optional(),
});
export type X402VerifyResponse = z.infer<typeof X402VerifyResponse>;
export const X402SettleResponse = z
  .object({
    success: z.boolean(),
    errorReason: z.string().optional(),
    payer: Address.optional(),
    transaction: TxHash.or(z.literal("")),
    network: z.string().regex(/^eip155:[1-9][0-9]*$/),
  })
  .refine(
    (value) =>
      value.errorReason !== "settlement_pending" || value.transaction !== "",
    "Pending settlement requires a transaction hash",
  );
export type X402SettleResponse = z.infer<typeof X402SettleResponse>;
export const X402Policy = z.object({
  merchantId: Bytes32,
  resource: X402Resource,
  requirements: X402Requirements,
});
export type X402Policy = z.infer<typeof X402Policy>;
export const DeliveryClaim = z.object({
  success: z.boolean(),
  errorReason: z.string().optional(),
  paymentId: Bytes32.optional(),
  leaseToken: z.string().optional(),
  leaseSeconds: z.number().int().positive().optional(),
});
export type DeliveryClaim = z.infer<typeof DeliveryClaim>;
export const PAYMENT_REQUIRED = "PAYMENT-REQUIRED",
  PAYMENT_SIGNATURE = "PAYMENT-SIGNATURE",
  PAYMENT_RESPONSE = "PAYMENT-RESPONSE";

export function encodeX402Header(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  if (bytes.length > 6144) throw new Error("Payment header exceeds 8 KiB");
  const result = btoa(String.fromCharCode(...bytes));
  if (result.length > 8192) throw new Error("Payment header exceeds 8 KiB");
  return result;
}
export function decodeX402Header<T>(
  value: string,
  schema: { parse(v: unknown): T },
): T {
  if (
    !value ||
    value.length > 8192 ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  )
    throw new Error("Invalid base64 payment header");
  const binary = atob(value);
  if (btoa(binary) !== value)
    throw new Error("Non-canonical base64 payment header");
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return schema.parse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  );
}
export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;
export function buildAgentAuthorization(args: {
  from: EvmAddress;
  to: EvmAddress;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
  chainId?: number;
  token?: EvmAddress;
  domainName?: string;
  domainVersion?: string;
}) {
  return {
    domain: tokenDomain({
      chainId: args.chainId,
      token: args.token,
      name: args.domainName,
      version: args.domainVersion,
    }),
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization" as const,
    message: {
      from: args.from,
      to: args.to,
      value: args.value,
      validAfter: args.validAfter,
      validBefore: args.validBefore,
      nonce: args.nonce,
    },
  };
}
export function makePaidPolicies(args: {
  baseUrl: string;
  merchantId: string;
  payTo: string;
  asset: string;
  chainId: number;
  name: string;
  version: string;
  quoteAmount?: string;
  signalAmount?: string;
}): X402Policy[] {
  const base = new URL(args.baseUrl);
  if (
    base.pathname !== "/" ||
    base.search ||
    base.hash ||
    base.username ||
    base.password
  )
    throw new Error(
      "Public API URL must be an origin without credentials, path or query",
    );
  return [
    ["/v1/quote", args.quoteAmount ?? "10000", "Demo market quote"],
    ["/v1/signal", args.signalAmount ?? "20000", "Demo market signal"],
  ].map(([path, amount, description]) =>
    X402Policy.parse({
      merchantId: args.merchantId,
      resource: {
        url: new URL(path!, base).href,
        description,
        mimeType: "application/json",
      },
      requirements: {
        scheme: "exact",
        network: `eip155:${args.chainId}`,
        asset: args.asset,
        amount,
        payTo: args.payTo,
        maxTimeoutSeconds: 60,
        extra: {
          name: args.name,
          version: args.version,
          assetTransferMethod: "eip3009",
          paymentFlow: "upfront",
        },
      },
    }),
  );
}
