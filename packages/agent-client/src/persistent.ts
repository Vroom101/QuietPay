/**
 * Crash-safe agent: intent -> signed -> submitted -> settled|failed, every step committed before the
 * next side effect. Opt-in through `createAgent({ ..., store: { path, secret, chain } })`.
 */
import {
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
import { AgentError, type AgentOptions, type PaymentLog } from "./index.js";
import {
  AgentStore,
  idempotencyKey,
  StoreError,
  type PaymentRecord,
  type StoreConfig,
} from "./store.js";
import {
  receiptProvesPayment,
  reconcileUnknown,
  resolveRecord,
} from "./recovery.js";

export interface RecoveryAction {
  nonce: Hex;
  action:
    | "settled"
    | "released"
    | "held"
    | "resubmitted"
    | "resigned"
    | "abandoned"
    | "waiting"
    | "error";
  detail?: string;
}

export function createPersistentAgent(
  options: AgentOptions & { store: StoreConfig },
) {
  const { signer, chainId, domainName, domainVersion } = options;
  const cfg = options.store;
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
  const cap = Math.max(1, cfg.maxTimeoutCapSeconds ?? 300);
  const margin = BigInt(Math.max(0, cfg.expiryMarginSeconds ?? 30));

  let store: AgentStore;
  try {
    store = AgentStore.open(cfg, {
      chainId,
      token: asset,
      payer: address,
      budget: sessionBudget,
      domainName,
      domainVersion,
    });
  } catch (e) {
    throw e;
  }
  const busy = new Set<Hex>();
  const fault = (p: string) => cfg.faultInjection?.(p);

  const checkedUrl = (value: string) => {
    const url = normalize(value);
    if (!origins.has(url.origin))
      throw new AgentError("budget_exceeded", "Origin is not allowed");
    return url.href;
  };
  const request = (url: string, header?: string, idem?: Hex) =>
    doFetch(url, {
      method: "GET",
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      headers: header
        ? { [PAYMENT_SIGNATURE]: header, ...(idem ? { "Idempotency-Key": idem } : {}) }
        : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
  const toLog = (r: PaymentRecord): PaymentLog => ({
    id: r.nonce,
    url: r.resource,
    amount: r.amount,
    payTo: r.payTo,
    status:
      r.state === "intent"
        ? "signing"
        : r.state === "settled"
          ? "settled"
          : r.state === "failed"
            ? "failed"
            : "unknown",
    delivered: r.delivered,
    ...(r.transaction
      ? {
          transaction: r.transaction,
          ...(explorer ? { explorerUrl: `${explorer}/tx/${r.transaction}` } : {}),
        }
      : {}),
  });
  const mapStoreError = (e: unknown): never => {
    if (e instanceof StoreError) {
      if (e.code === "budget")
        throw new AgentError("budget_exceeded", e.message);
      if (e.code === "pending")
        throw new AgentError("payment_pending", e.message);
    }
    throw e;
  };

  /** Sign the stored terms (never new terms) and commit the signature before anything is sent. */
  async function signStored(rec: PaymentRecord): Promise<PaymentRecord> {
    const { resource, accepted } = JSON.parse(rec.accepted) as {
      resource: unknown;
      accepted: unknown;
    };
    const typedData = buildAgentAuthorization({
      from: address,
      to: getAddress(rec.payTo),
      value: BigInt(rec.amount),
      validAfter: BigInt(rec.validAfter),
      validBefore: BigInt(rec.validBefore),
      nonce: rec.nonce,
      chainId,
      token: asset,
      domainName,
      domainVersion,
    });
    let signature: Hex, payload: X402Payload;
    try {
      signature = await signer.signTypedData(typedData);
      payload = X402Payload.parse({
        x402Version: 2,
        resource,
        accepted,
        payload: {
          signature,
          authorization: {
            from: address,
            to: rec.payTo,
            value: rec.amount,
            validAfter: rec.validAfter,
            validBefore: rec.validBefore,
            nonce: rec.nonce,
          },
        },
      });
      if (
        (
          await recoverTypedDataAddress({ ...typedData, signature })
        ).toLowerCase() !== address.toLowerCase()
      )
        throw new Error("Signer returned an invalid signature");
    } catch (error) {
      // The intent stays committed: budget is held until expiry is proven.
      throw new AgentError(
        "invalid_payment",
        error instanceof Error ? error.message : "Signing failed",
        rec.nonce,
      );
    }
    fault("after:sign-before-store");
    return store.markSigned(rec.nonce, signature, JSON.stringify(payload));
  }

  async function send(rec0: PaymentRecord): Promise<Response> {
    if (busy.has(rec0.nonce))
      throw new AgentError("payment_pending", "This payment already has a request in flight", rec0.nonce);
    busy.add(rec0.nonce);
    try {
      let rec = rec0;
      if (!rec.payload || rec.delivered || rec.released)
        throw new AgentError("payment_failed", "Payment cannot be retried", rec.nonce);
      if (rec.state === "signed" || rec.state === "failed")
        rec = store.markSubmitted(rec.nonce);
      const payload = X402Payload.parse(JSON.parse(rec.payload!));
      const idem = idempotencyKey({
        chainId,
        token: asset,
        payer: address,
        nonce: rec.nonce,
      });
      fault("before:send");
      let response: Response;
      try {
        // Always resend the identical payload; a 402 never triggers another signature here.
        response = await request(rec.resource, encodeX402Header(payload), idem);
      } catch (error) {
        throw new AgentError(
          "payment_status_unknown",
          error instanceof Error ? error.message : "Payment status unknown",
          rec.nonce,
        );
      }
      fault("after:response-before-store");
      const header = response.headers.get(PAYMENT_RESPONSE);
      if (!header)
        throw new AgentError(
          "payment_status_unknown",
          `No settlement receipt (HTTP ${response.status}); payment may have been accepted`,
          rec.nonce,
        );
      let result;
      try {
        result = decodeX402Header(header, X402SettleResponse);
        if (
          result.network !== `eip155:${chainId}` ||
          (result.payer && result.payer.toLowerCase() !== address.toLowerCase()) ||
          (result.success && (!result.payer || !result.transaction))
        )
          throw new Error("Settlement response does not match this payment");
        if (
          result.transaction &&
          rec.transaction &&
          rec.transaction !== result.transaction
        )
          throw new Error("Settlement transaction changed");
      } catch (error) {
        throw new AgentError(
          "payment_status_unknown",
          error instanceof Error ? error.message : "Payment status unknown",
          rec.nonce,
        );
      }
      if (result.transaction)
        rec = store.noteTransaction(rec.nonce, result.transaction as Hex);
      if (result.success) {
        // The header is the facilitator's word: believe it only once the receipt proves it.
        let proven = false;
        try {
          proven = receiptProvesPayment(
            await cfg.chain.getReceipt(result.transaction as Hex),
            rec,
            asset,
            address,
          );
        } catch {
          /* chain unavailable: stay unresolved */
        }
        if (!proven)
          throw new AgentError(
            "payment_status_unknown",
            "Settlement claimed but not yet proven on chain; run recover()",
            rec.nonce,
          );
        store.markSettled(rec.nonce, result.transaction as Hex, response.ok);
        if (response.ok) return response;
        throw new AgentError(
          "payment_failed",
          `Payment settled but resource returned HTTP ${response.status}; retry the same payment`,
          rec.nonce,
        );
      }
      if (result.errorReason === "settlement_pending")
        throw new AgentError(
          "payment_pending",
          "Settlement pending; retry this payment",
          rec.nonce,
        );
      // Failure is a claim; budget stays reserved until finalized chain proves expiry.
      store.markFailed(rec.nonce, result.errorReason ?? "rejected");
      throw new AgentError(
        "payment_failed",
        result.errorReason ?? "Payment rejected",
        rec.nonce,
      );
    } finally {
      busy.delete(rec0.nonce);
    }
  }

  /** Move one unresolved record forward with its ORIGINAL nonce and terms. */
  async function advance(rec: PaymentRecord): Promise<RecoveryAction["action"]> {
    const latest = await cfg.chain.latestTimestamp();
    const left = BigInt(rec.validBefore) - latest;
    if (rec.state === "intent") {
      if (left <= margin) {
        store.markAbandoned(rec.nonce);
        return "abandoned";
      }
      const signed = await signStored(rec);
      await send(signed).then((r) => r.body?.cancel());
      return "resigned";
    }
    if (left <= 0n) return "waiting";
    await send(rec).then((r) => r.body?.cancel());
    return "resubmitted";
  }

  return {
    get reservedAmount() {
      return store.reserved();
    },
    get payments(): PaymentLog[] {
      return store.list().map(toLog);
    },
    get sessionId() {
      return store.sessionId;
    },
    async fetch(value: string): Promise<Response> {
      const url = checkedUrl(value);
      const open = store.openForResource(url);
      const response = await request(url);
      if (open) {
        // A stored payment owns this resource. If the server now asks for different terms, refuse.
        if (response.status === 402) {
          try {
            const req = decodeX402Header(
              response.headers.get(PAYMENT_REQUIRED) ?? "",
              X402Required,
            );
            const stored = JSON.parse(open.accepted) as {
              accepted: { amount: string; payTo: string; asset: string; network: string };
            };
            const same = req.accepts.some(
              (a) =>
                a.amount === stored.accepted.amount &&
                a.payTo.toLowerCase() === stored.accepted.payTo.toLowerCase() &&
                a.asset.toLowerCase() === stored.accepted.asset.toLowerCase() &&
                a.network === stored.accepted.network,
            );
            if (!same)
              throw new AgentError(
                "invalid_payment",
                "Server terms differ from the stored payment; refusing to sign",
                open.nonce,
              );
          } catch (e) {
            if (e instanceof AgentError) throw e;
            throw new AgentError("invalid_payment", "Malformed payment challenge or wrong resource");
          }
        }
        throw new AgentError(
          "payment_pending",
          "Resolve the previous payment with retry(id) or recover() before authorizing another for this resource",
          open.nonce,
        );
      }
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
      const reservedNow = store.reserved();
      const accepted = required.accepts.find(
        (a) =>
          a.network === `eip155:${chainId}` &&
          a.asset.toLowerCase() === asset.toLowerCase() &&
          a.extra.name === domainName &&
          a.extra.version === domainVersion &&
          recipients.has(a.payTo.toLowerCase()) &&
          BigInt(a.amount) <= perCallLimit &&
          reservedNow + BigInt(a.amount) <= sessionBudget,
      );
      if (!accepted)
        throw new AgentError(
          "budget_exceeded",
          "No payment option satisfies network, token, domain, recipient and spending rules",
        );
      let latest: bigint;
      try {
        latest = await cfg.chain.latestTimestamp();
      } catch {
        throw new AgentError("invalid_payment", "Chain time unavailable; nothing was signed");
      }
      const timeout = Math.min(cap, Math.max(1, accepted.maxTimeoutSeconds - 5));
      let rec: PaymentRecord;
      try {
        rec = store.reserveIntent({
          to: accepted.payTo as Address,
          value: BigInt(accepted.amount),
          validAfter: 0n,
          validBefore: latest + BigInt(timeout),
          resource: url,
          accepted: JSON.stringify({ resource: required.resource, accepted }),
        });
      } catch (e) {
        return mapStoreError(e);
      }
      rec = await signStored(rec);
      return send(rec);
    },
    async retry(id: Hex): Promise<Response> {
      const rec = store.get(id);
      if (!rec) throw new AgentError("payment_failed", "Unknown payment", id);
      if (rec.state === "intent") {
        const latest = await cfg.chain.latestTimestamp();
        if (BigInt(rec.validBefore) - latest <= margin)
          throw new AgentError(
            "payment_pending",
            "Authorization is about to expire; recover() will hold it until expiry is proven",
            id,
          );
        return send(await signStored(rec));
      }
      return send(rec);
    },
    /** Resolve every unresolved record from chain evidence; never signs a new nonce. */
    async recover(): Promise<RecoveryAction[]> {
      store.verify();
      const out: RecoveryAction[] = [];
      for (const rec of store.unresolved()) {
        try {
          const res = await resolveRecord(rec, {
            chain: cfg.chain,
            facilitator: cfg.facilitator,
            token: asset,
            payer: address,
          });
          if (res.outcome === "settled") {
            store.markSettled(rec.nonce, res.transaction, rec.delivered);
            out.push({ nonce: rec.nonce, action: "settled" });
          } else if (res.outcome === "released") {
            store.release(rec.nonce, res.finalizedTimestamp);
            out.push({ nonce: rec.nonce, action: "released" });
          } else if (res.outcome === "held") {
            if (rec.note !== res.reason) store.setNote(rec.nonce, res.reason);
            out.push({ nonce: rec.nonce, action: "held", detail: res.reason });
          } else if (rec.state === "failed" || res.facilitator === "pending") {
            out.push({ nonce: rec.nonce, action: "waiting" });
          } else {
            out.push({ nonce: rec.nonce, action: await advance(rec) });
          }
        } catch (e) {
          if (cfg.faultInjection && !(e instanceof AgentError)) throw e;
          out.push({
            nonce: rec.nonce,
            action: "error",
            detail: e instanceof Error ? e.message : String(e),
          });
        }
      }
      return out;
    },
    /** Nonces the payer used on chain that this store never recorded (restored backup evidence). */
    async reconcile(): Promise<Hex[]> {
      return reconcileUnknown(cfg.chain, asset, address, store.list());
    },
    close() {
      store.close();
    },
  };
}
