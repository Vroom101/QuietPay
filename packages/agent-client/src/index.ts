import {
  bytesToHex,
  getAddress,
  recoverTypedDataAddress,
  type Address,
  type Hex,
} from "viem";
import {
  buildAgentAuthorization,
  decodeX402Header,
  encodeX402Header,
  PAYMENT_REQUIRED,
  PAYMENT_SIGNATURE,
  PAYMENT_RESPONSE,
  X402Required,
  X402Payload,
  X402SettleResponse,
} from "@quietpay/shared";
import { createPersistentAgent } from "./persistent.js";
import type { StoreConfig } from "./store.js";

export * from "./store.js";
export * from "./recovery.js";
export { createPersistentAgent } from "./persistent.js";
export type { RecoveryAction } from "./persistent.js";

export class AgentError extends Error {
  constructor(
    public readonly code:
      | "budget_exceeded"
      | "invalid_payment"
      | "payment_pending"
      | "payment_status_unknown"
      | "payment_failed",
    message: string,
    public readonly paymentId?: Hex,
  ) {
    super(message);
    this.name = "AgentError";
  }
}
export interface AgentOptions {
  signer: {
    address: Address;
    signTypedData: (
      data: ReturnType<typeof buildAgentAuthorization>,
    ) => Promise<Hex>;
  };
  chainId: number;
  asset: Address;
  domainName: string;
  domainVersion: string;
  /** Exact origins, including scheme and port. HTTP is permitted only for loopback development. */
  allowedOrigins: string[];
  allowedPayTo: Address[];
  perCallLimit: bigint;
  sessionBudget: bigint;
  explorerUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /**
   * Opt in to crash-safe persisted state (SQLite). Without it the agent is in-memory only.
   * See store.ts for the threat model.
   */
  store?: StoreConfig;
}
export interface PaymentLog {
  id: Hex;
  url: string;
  amount: string;
  payTo: string;
  status: "signing" | "unknown" | "pending" | "settled" | "failed";
  delivered: boolean;
  transaction?: Hex;
  explorerUrl?: string;
}
interface Payment {
  log: PaymentLog;
  payload?: X402Payload;
  busy: boolean;
}

/** One in-memory spending session. Every signature consumes budget, even if delivery fails. */
export function createAgent(
  options: AgentOptions & { store: StoreConfig },
): ReturnType<typeof createPersistentAgent>;
export function createAgent(options: AgentOptions): InMemoryAgent;
export function createAgent(options: AgentOptions): any {
  if (options.store)
    return createPersistentAgent(options as AgentOptions & { store: StoreConfig });
  // Snapshot policy: callers cannot relax it by mutating their options later.
  const { signer, chainId, domainName, domainVersion } = options;
  const address = getAddress(signer.address),
    asset = getAddress(options.asset);
  const perCallLimit = options.perCallLimit,
    sessionBudget = options.sessionBudget;
  if (
    !Number.isSafeInteger(chainId) ||
    chainId < 1 ||
    perCallLimit <= 0n ||
    sessionBudget <= 0n
  )
    throw new Error("Positive chain and spending limits required");
  const normalize = (value: string) => {
    const url = new URL(value);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      url.username ||
      url.password ||
      url.hash ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    )
      throw new AgentError(
        "budget_exceeded",
        "Only HTTPS or loopback HTTP URLs without credentials or fragments are allowed",
      );
    return url;
  };
  const origins = new Set(
    options.allowedOrigins.map((value) => {
      const url = normalize(value);
      if (url.pathname !== "/" || url.search)
        throw new Error("Allowlist entries must be origins");
      return url.origin;
    }),
  );
  const recipients = new Set(
    options.allowedPayTo.map((a) => getAddress(a).toLowerCase()),
  );
  if (!origins.size || !recipients.size)
    throw new Error("Nonempty origin and recipient allowlists required");
  const explorer = options.explorerUrl
    ? normalize(options.explorerUrl).href.replace(/\/$/, "")
    : undefined;
  const doFetch = options.fetch ?? fetch,
    timeoutMs = options.timeoutMs ?? 15000;
  const payments = new Map<Hex, Payment>();
  let reserved = 0n;
  function checkedUrl(value: string) {
    const url = normalize(value);
    if (!origins.has(url.origin))
      throw new AgentError("budget_exceeded", "Origin is not allowed");
    return url.href;
  }
  const request = (url: string, header?: string) =>
    doFetch(url, {
      method: "GET",
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      headers: header ? { [PAYMENT_SIGNATURE]: header } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
  async function send(payment: Payment): Promise<Response> {
    if (payment.busy)
      throw new AgentError(
        "payment_pending",
        "This payment already has a request in flight",
        payment.log.id,
      );
    if (!payment.payload || payment.log.delivered)
      throw new AgentError(
        "payment_failed",
        "Payment cannot be retried",
        payment.log.id,
      );
    payment.busy = true;
    try {
      // Always retry the original payload; a 402 never triggers another signature here.
      const response = await request(
        payment.log.url,
        encodeX402Header(payment.payload),
      );
      const header = response.headers.get(PAYMENT_RESPONSE);
      if (header) {
        const result = decodeX402Header(header, X402SettleResponse);
        if (
          result.network !== `eip155:${chainId}` ||
          (result.payer &&
            result.payer.toLowerCase() !== address.toLowerCase()) ||
          (result.success && (!result.payer || !result.transaction))
        )
          throw new Error("Settlement response does not match this payment");
        if (result.transaction) {
          if (
            payment.log.transaction &&
            payment.log.transaction !== result.transaction
          )
            throw new Error("Settlement transaction changed");
          payment.log.transaction = result.transaction as Hex;
          if (explorer)
            payment.log.explorerUrl = `${explorer}/tx/${result.transaction}`;
        }
        if (result.success) {
          payment.log.status = "settled";
          payment.log.delivered = response.ok;
          if (response.ok) return response;
          throw new AgentError(
            "payment_failed",
            `Payment settled but resource returned HTTP ${response.status}; retry the same payment`,
            payment.log.id,
          );
        }
        if (result.errorReason === "settlement_pending") {
          payment.log.status = "pending";
          throw new AgentError(
            "payment_pending",
            "Settlement pending; retry this payment",
            payment.log.id,
          );
        }
        payment.log.status = "failed";
        throw new AgentError(
          "payment_failed",
          result.errorReason ?? "Payment rejected",
          payment.log.id,
        );
      }
      throw new Error(
        `No settlement receipt (HTTP ${response.status}); payment may have been accepted`,
      );
    } catch (error) {
      if (error instanceof AgentError) throw error;
      if (payment.log.status !== "settled") payment.log.status = "unknown";
      throw new AgentError(
        "payment_status_unknown",
        error instanceof Error ? error.message : "Payment status unknown",
        payment.log.id,
      );
    } finally {
      payment.busy = false;
    }
  }
  return {
    get reservedAmount() {
      return reserved;
    },
    get payments(): PaymentLog[] {
      return [...payments.values()].map((p) => ({ ...p.log }));
    },
    async fetch(value: string): Promise<Response> {
      const url = checkedUrl(value);
      const unresolved = [...payments.values()].find(
        (p) => p.log.url === url && !p.log.delivered,
      );
      if (unresolved)
        throw new AgentError(
          "payment_pending",
          "Resolve the previous payment with retry(id) before authorizing another for this resource",
          unresolved.log.id,
        );
      const response = await request(url);
      if (response.status !== 402) return response;
      let required: X402Required;
      try {
        required = decodeX402Header(
          response.headers.get(PAYMENT_REQUIRED) ?? "",
          X402Required,
        );
        if (
          new URL(required.resource.url).href !== url ||
          Object.keys(required.extensions ?? {}).length
        )
          throw new Error("Resource mismatch or unsupported extensions");
      } catch {
        throw new AgentError(
          "invalid_payment",
          "Malformed payment challenge or wrong resource",
        );
      }
      const accepted = required.accepts.find(
        (a) =>
          a.network === `eip155:${chainId}` &&
          a.asset.toLowerCase() === asset.toLowerCase() &&
          a.extra.name === domainName &&
          a.extra.version === domainVersion &&
          recipients.has(a.payTo.toLowerCase()) &&
          BigInt(a.amount) <= perCallLimit &&
          reserved + BigInt(a.amount) <= sessionBudget,
      );
      if (!accepted)
        throw new AgentError(
          "budget_exceeded",
          "No payment option satisfies network, token, domain, recipient and spending rules",
        );
      // No awaits between the final budget check and reservation: concurrent calls cannot overspend.
      const amount = BigInt(accepted.amount),
        id = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
      const payment: Payment = {
        busy: true,
        log: {
          id,
          url,
          amount: amount.toString(),
          payTo: accepted.payTo,
          status: "signing",
          delivered: false,
        },
      };
      // Another request may have obtained a challenge while we awaited the first response.
      if (
        [...payments.values()].some(
          (p) => p.log.url === url && !p.log.delivered,
        )
      )
        throw new AgentError(
          "payment_pending",
          "Another payment for this resource is in progress",
        );
      reserved += amount;
      payments.set(id, payment);
      try {
        const authorization = {
          from: address,
          to: accepted.payTo,
          value: accepted.amount,
          validAfter: "0",
          validBefore: String(
            Math.floor(Date.now() / 1000) +
              Math.max(1, accepted.maxTimeoutSeconds - 5),
          ),
          nonce: id,
        };
        const typedData = buildAgentAuthorization({
          from: address,
          to: getAddress(accepted.payTo),
          value: amount,
          validAfter: 0n,
          validBefore: BigInt(authorization.validBefore),
          nonce: id,
          chainId,
          token: asset,
          domainName,
          domainVersion,
        });
        const signature = await signer.signTypedData(typedData);
        payment.payload = X402Payload.parse({
          x402Version: 2,
          resource: required.resource,
          accepted,
          payload: { signature, authorization },
        });
        if (
          (
            await recoverTypedDataAddress({ ...typedData, signature })
          ).toLowerCase() !== address.toLowerCase()
        )
          throw new Error("Signer returned an invalid signature");
        payment.log.status = "unknown";
      } catch (error) {
        // A signer may already have produced a usable authorization: retain its reservation conservatively.
        payment.log.status = "failed";
        payment.busy = false;
        throw new AgentError(
          "invalid_payment",
          error instanceof Error ? error.message : "Signing failed",
          id,
        );
      }
      payment.busy = false;
      return send(payment);
    },
    async retry(id: Hex): Promise<Response> {
      const payment = payments.get(id);
      if (!payment)
        throw new AgentError("payment_failed", "Unknown payment", id);
      return send(payment);
    },
  };
}
export interface InMemoryAgent {
  readonly reservedAmount: bigint;
  readonly payments: PaymentLog[];
  fetch(url: string): Promise<Response>;
  retry(id: Hex): Promise<Response>;
}
