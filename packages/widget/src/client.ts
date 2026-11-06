import {
  ErrorResponse,
  GetOrderResponse,
  QUALIFYING_CHAIN_ID,
  QUALIFYING_USDT,
  RelayPayResponse,
  buildCheckoutAuthorization,
  computePayNonce,
  getQualifyingDeployment,
  token,
  type Order,
  type RelayPayRequest,
} from "@quietpay/shared";
import { isAddress, type Address, type Hex } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { NETWORK_MESSAGE } from "./messages.js";

/** Error carrying a relayer code (or "network"/"timeout"/"unknown") for the UI to map to plain words. */
export class WidgetError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "WidgetError";
  }
}

const trim = (u: string) => u.replace(/\/+$/, "");

async function request(url: string, init?: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new WidgetError("network", NETWORK_MESSAGE);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  if (!res.ok) {
    const parsed = ErrorResponse.safeParse(body);
    if (parsed.success) throw new WidgetError(parsed.data.error.code, parsed.data.error.message);
    throw new WidgetError("unknown", "unknown error");
  }
  return body;
}

export async function fetchOrder(relayerUrl: string, orderId: string): Promise<Order> {
  const body = await request(`${trim(relayerUrl)}/v1/orders/${orderId}`);
  const parsed = GetOrderResponse.safeParse(body);
  if (!parsed.success) throw new WidgetError("unknown", "malformed order");
  return parsed.data;
}

export async function relayPay(relayerUrl: string, req: RelayPayRequest) {
  const body = await request(`${trim(relayerUrl)}/v1/relay/pay`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
  });
  const parsed = RelayPayResponse.safeParse(body);
  if (!parsed.success) throw new WidgetError("unknown", "malformed response");
  return parsed.data;
}

/**
 * What the widget expects the relayer's checkout to be. Every field is optional; the defaults are the only
 * qualifying values (chain 1874, the official USDT, the router recorded in the shared deployments, the token's
 * EIP-712 domain from token.json). Overrides exist for local anvil tests and must come from the host page,
 * never from the relayer.
 */
export interface ExpectedCheckout {
  /** The order id the widget asked for; the relayer must answer with that order. */
  orderId?: string;
  chainId?: number;
  token?: string;
  /** Required when chainId is not the qualifying chain (no deployment default exists there). */
  router?: string;
  domainName?: string;
  domainVersion?: string;
  /** Exact amount in token base units the shop expects the payer to pay. */
  amount?: bigint;
  /** Optional merchant payout address the shop pins. */
  payout?: string;
}

/** Longest validity the widget will ever put on a signature, counted from now. */
export const MAX_WIDGET_WINDOW_SECONDS = 300;
/** Back-dating of validAfter so small clock skew does not reject the authorization. */
const BACKDATE_SECONDS = 5;

function refuse(code: string, detail: string): never {
  throw new WidgetError(code, `checkout refused: ${detail}`);
}
const sameAddress = (a: string, b: string) => isAddress(a, { strict: false }) && isAddress(b, { strict: false }) && a.toLowerCase() === b.toLowerCase();
const isUint = (s: unknown): s is string => typeof s === "string" && /^(0|[1-9][0-9]{0,77})$/.test(s);

/**
 * Refuses (throws WidgetError "checkout_*") unless the relayer's checkout is exactly what the payer should sign:
 * the qualifying chain, token, router and domain (or the host page's explicit overrides), a value equal to the
 * displayed amount, a fee below the value, a consistent payout, and a nonce recomputed locally from the order.
 * Must run before any signing: a hostile relayer could otherwise get a ReceiveWithAuthorization to its own contract.
 */
export function verifyCheckout(order: Order, expected: ExpectedCheckout = {}): void {
  const c = order?.checkout;
  if (!c) refuse("checkout_order_mismatch", "missing checkout");

  const chainId = expected.chainId ?? QUALIFYING_CHAIN_ID;
  const tokenAddr = expected.token ?? QUALIFYING_USDT;
  let router = expected.router;
  if (router === undefined) {
    if (chainId !== QUALIFYING_CHAIN_ID) refuse("checkout_config_invalid", "a router must be set for a non-qualifying chain");
    try {
      router = getQualifyingDeployment().router;
    } catch {
      refuse("checkout_config_invalid", "no qualifying router deployment recorded");
    }
  }
  if (!Number.isSafeInteger(chainId) || !isAddress(tokenAddr, { strict: false }) || !isAddress(router!, { strict: false })) {
    refuse("checkout_config_invalid", "expected chain/token/router is malformed");
  }
  const domainName = expected.domainName ?? token.eip712Domain.name;
  const domainVersion = expected.domainVersion ?? token.eip712Domain.version;

  if (expected.orderId !== undefined && String(order.id).toLowerCase() !== expected.orderId.toLowerCase()) {
    refuse("checkout_order_mismatch", "relayer returned a different order");
  }
  if (c.chainId !== chainId) refuse("checkout_chain_mismatch", "wrong chain");
  if (!sameAddress(c.token, tokenAddr)) refuse("checkout_token_mismatch", "wrong token");
  if (!sameAddress(c.router, router!)) refuse("checkout_router_mismatch", "wrong router");
  if (!c.domain || c.domain.name !== domainName || c.domain.version !== domainVersion) {
    refuse("checkout_domain_mismatch", "wrong token domain");
  }

  // Re-assert the schema refinement: what is displayed is what is signed.
  if (!isUint(order.amount) || !isUint(c.value) || order.amount !== c.value || BigInt(c.value) === 0n) {
    refuse("checkout_amount_mismatch", "signed value differs from the order amount");
  }
  if (expected.amount !== undefined && BigInt(order.amount) !== expected.amount) {
    refuse("checkout_amount_mismatch", "order amount differs from the amount the shop expects");
  }
  if (!isUint(order.fee) || !isUint(c.fee) || order.fee !== c.fee) refuse("checkout_fee_mismatch", "fee differs");
  if (BigInt(c.fee) >= BigInt(c.value)) refuse("checkout_fee_invalid", "fee must be below the value");
  if (!sameAddress(order.payout, c.payout)) refuse("checkout_payout_mismatch", "payout differs");
  if (expected.payout !== undefined && !sameAddress(c.payout, expected.payout)) {
    refuse("checkout_payout_mismatch", "payout differs from the one the shop expects");
  }

  let nonce: string;
  try {
    nonce = computePayNonce({
      merchantId: order.merchantId as Hex,
      orderId: order.id as Hex,
      payout: c.payout as Address,
      value: BigInt(c.value),
      fee: BigInt(c.fee),
    });
  } catch {
    return refuse("checkout_nonce_mismatch", "order fields cannot be encoded");
  }
  if (typeof c.nonce !== "string" || c.nonce.toLowerCase() !== nonce.toLowerCase()) {
    refuse("checkout_nonce_mismatch", "nonce is not derived from this order");
  }
}

/**
 * Identity of the order the payer was shown, captured by the widget itself when it first displays the order (never
 * taken from host attributes or a later relayer answer). Everything that ends up in the signed authorization, or
 * that the payer reads on screen as "who" and "how much", is here. Status and expiry are deliberately absent: they
 * may legitimately change between display and signing.
 */
export interface DisplayedOrder {
  readonly id: string;
  readonly merchantId: string;
  readonly amount: string;
  readonly fee: string;
  readonly payout: string;
  readonly nonce: string;
  readonly chainId: number;
  readonly token: string;
  readonly router: string;
  readonly domainName: string;
  readonly domainVersion: string;
}

/** Snapshot of what is displayed. Throws WidgetError("checkout_order_mismatch") if the order has no checkout. */
export function pinDisplayedOrder(order: Order): Readonly<DisplayedOrder> {
  const c = order?.checkout;
  if (!c || !c.domain) refuse("checkout_order_mismatch", "missing checkout");
  return Object.freeze({
    id: String(order.id),
    merchantId: String(order.merchantId),
    amount: String(order.amount),
    fee: String(order.fee),
    payout: String(order.payout),
    nonce: String(c.nonce),
    chainId: c.chainId,
    token: String(c.token),
    router: String(c.router),
    domainName: String(c.domain.name),
    domainVersion: String(c.domain.version),
  });
}

const sameHex = (a: unknown, b: string) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();

/**
 * Refuses (WidgetError "checkout_display_mismatch", nothing signed) unless the freshly fetched order is the very
 * order the payer was shown: same id, merchant, amount, fee, payout, nonce, chain, token, router and token domain.
 * verifyCheckout only checks an order against itself and the host's expectations; this ties it to the screen.
 */
export function verifyDisplayedOrder(order: Order, displayed: DisplayedOrder): void {
  const c = order?.checkout;
  const differs = (field: string): never => refuse("checkout_display_mismatch", `${field} differs from what was displayed`);
  if (!c || !c.domain) refuse("checkout_order_mismatch", "missing checkout");
  if (!sameHex(order.id, displayed.id)) differs("order id");
  if (!sameHex(order.merchantId, displayed.merchantId)) differs("merchant");
  if (order.amount !== displayed.amount || c.value !== displayed.amount) differs("amount");
  if (order.fee !== displayed.fee || c.fee !== displayed.fee) differs("fee");
  if (!sameHex(order.payout, displayed.payout) || !sameHex(c.payout, displayed.payout)) differs("payout");
  if (!sameHex(c.nonce, displayed.nonce)) differs("nonce");
  if (c.chainId !== displayed.chainId) differs("chain");
  if (!sameHex(c.token, displayed.token)) differs("token");
  if (!sameHex(c.router, displayed.router)) differs("router");
  if (c.domain.name !== displayed.domainName || c.domain.version !== displayed.domainVersion) differs("token domain");
}

export interface SignCheckoutOptions {
  /** Checked with verifyCheckout before signing. Defaults to the qualifying values. */
  expected?: ExpectedCheckout;
  /** When set, the order must match what the payer was shown (verifyDisplayedOrder) before anything is signed. */
  displayed?: DisplayedOrder;
  /** Seconds from now until validBefore. At most MAX_WIDGET_WINDOW_SECONDS. */
  windowSeconds?: number;
}

/**
 * Verifies the order (verifyCheckout) and only then builds and signs the single ReceiveWithAuthorization the payer
 * approves. Throws WidgetError("checkout_*") without signing when anything is off.
 */
export async function signCheckout(
  account: PrivateKeyAccount,
  order: Order,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  opts: SignCheckoutOptions = {},
): Promise<RelayPayRequest> {
  const windowSeconds = opts.windowSeconds ?? MAX_WIDGET_WINDOW_SECONDS;
  if (!Number.isInteger(windowSeconds) || windowSeconds <= 0 || windowSeconds > MAX_WIDGET_WINDOW_SECONDS) {
    refuse("checkout_window_invalid", "validity window must be 1..300 seconds");
  }
  if (opts.displayed !== undefined) verifyDisplayedOrder(order, opts.displayed);
  verifyCheckout(order, opts.expected);
  const validAfter = nowSeconds - BACKDATE_SECONDS;
  const validBefore = nowSeconds + windowSeconds;
  const c = order.checkout;
  const td = buildCheckoutAuthorization({
    from: account.address,
    router: c.router as `0x${string}`,
    value: BigInt(c.value),
    nonce: c.nonce as `0x${string}`,
    validAfter: BigInt(validAfter),
    validBefore: BigInt(validBefore),
    chainId: c.chainId,
    token: c.token as `0x${string}`,
    domainName: c.domain.name,
    domainVersion: c.domain.version,
  });
  const signature = await account.signTypedData(td);
  return { orderId: order.id, payer: account.address, validAfter, validBefore, signature, amount: order.amount };
}

export interface PollOptions {
  intervalMs?: number;
  timeoutMs?: number;
  onUpdate?: (o: Order) => void;
}

/** Polls until the order is settled / failed / expired. Throws WidgetError("timeout") after the timeout. */
export async function pollOrder(relayerUrl: string, orderId: string, opts: PollOptions = {}): Promise<Order> {
  const interval = opts.intervalMs ?? 1000;
  const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
  for (;;) {
    const o = await fetchOrder(relayerUrl, orderId);
    opts.onUpdate?.(o);
    if (o.status === "settled" || o.status === "failed" || o.status === "expired") return o;
    if (Date.now() >= deadline) throw new WidgetError("timeout", "timeout");
    await new Promise((r) => setTimeout(r, interval));
  }
}
