/**
 * Evidence-based resolution of stored payments. Rules (settled by design review):
 *  - Local clock is never consulted. A record is expired only when a FINALIZED block timestamp is
 *    strictly greater than validBefore.
 *  - authorizationState is read at the finalized tag, AFTER the finalized timestamp was read, so a
 *    transfer included before expiry cannot be missed.
 *  - A true authorizationState proves nothing about OUR payment (cancelAuthorization also sets it):
 *    "settled" requires a successful receipt with AuthorizationUsed(payer, nonce) on the token AND
 *    Transfer(payer -> payTo, value) on the token.
 *  - The facilitator is advisory. It can never release budget, and a "settled" claim is only
 *    believed after the receipt is verified.
 *  - Budget is released only on proven failure: finalized expiry, nonce unused, and the facilitator
 *    does not claim settled/pending.
 */
import {
  getAddress,
  keccak256,
  pad,
  parseAbi,
  parseAbiItem,
  stringToHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import type {
  ChainEvidence,
  FacilitatorStatus,
  PaymentRecord,
  ReceiptEvidence,
  StoreConfig,
} from "./store.js";

export const AUTHORIZATION_USED_TOPIC = keccak256(
  stringToHex("AuthorizationUsed(address,bytes32)"),
);
export const TRANSFER_TOPIC = keccak256(
  stringToHex("Transfer(address,address,uint256)"),
);
const lower = (s: string) => s.toLowerCase();
const topicAddr = (a: Address) => lower(pad(a, { size: 32 }));

/** True only for a successful receipt that proves THIS authorization paid THIS recipient this amount. */
export function receiptProvesPayment(
  receipt: ReceiptEvidence | null | undefined,
  rec: Pick<PaymentRecord, "nonce" | "payTo" | "amount">,
  token: Address,
  payer: Address,
): boolean {
  if (!receipt?.success) return false;
  const mine = receipt.logs.filter((l) => lower(l.address) === lower(token));
  const used = mine.some(
    (l) =>
      l.topics.length === 3 &&
      lower(l.topics[0]) === lower(AUTHORIZATION_USED_TOPIC) &&
      lower(l.topics[1]) === topicAddr(payer) &&
      lower(l.topics[2]) === lower(rec.nonce),
  );
  const value = BigInt(rec.amount);
  const transferred = mine.some((l) => {
    if (
      l.topics.length !== 3 ||
      lower(l.topics[0]) !== lower(TRANSFER_TOPIC) ||
      lower(l.topics[1]) !== topicAddr(payer) ||
      lower(l.topics[2]) !== topicAddr(rec.payTo as Address)
    )
      return false;
    try {
      return BigInt(l.data) === value;
    } catch {
      return false;
    }
  });
  return used && transferred;
}

export type Resolution =
  | { outcome: "settled"; transaction: Hex }
  | { outcome: "released"; finalizedTimestamp: bigint }
  | { outcome: "live"; facilitator: FacilitatorStatus }
  | { outcome: "held"; reason: string };

export interface ResolveDeps {
  chain: ChainEvidence;
  facilitator?: StoreConfig["facilitator"];
  token: Address;
  payer: Address;
}

export async function resolveRecord(
  rec: PaymentRecord,
  deps: ResolveDeps,
): Promise<Resolution> {
  const { chain, token, payer } = deps;
  // Order matters: finalized time first, then state at the finalized tag.
  const finalizedTs = await chain.finalizedTimestamp();
  const used = await chain.authorizationUsedAtFinalized(token, payer, rec.nonce);
  let tx: Hex | null = rec.transaction;
  if (!tx) tx = await chain.findAuthorizationUsedTx(token, payer, rec.nonce);
  let fac: { status: FacilitatorStatus; transaction?: Hex } = { status: "unknown" };
  if (deps.facilitator) {
    try {
      const r = await deps.facilitator.status({ payer, nonce: rec.nonce });
      if (["settled", "pending", "failed", "unknown"].includes(r?.status))
        fac = r;
    } catch {
      /* facilitator down: advisory only */
    }
  }
  const candidates = [...new Set([tx, fac.transaction].filter(Boolean) as Hex[])];
  let sawUnmatched = false;
  for (const t of candidates) {
    const receipt = await chain.getReceipt(t);
    if (receiptProvesPayment(receipt, rec, token, payer))
      return { outcome: "settled", transaction: t };
    if (receipt) sawUnmatched = true;
  }
  if (used)
    return {
      outcome: "held",
      reason: sawUnmatched || !candidates.length
        ? "authorization_used_without_matching_receipt"
        : "authorization_used_receipt_unavailable",
    };
  if (sawUnmatched)
    return { outcome: "held", reason: "foreign_or_unmatched_transaction" };
  if (finalizedTs > BigInt(rec.validBefore)) {
    if (fac.status === "settled" || fac.status === "pending")
      return { outcome: "held", reason: `facilitator_${fac.status}_but_chain_expired_unused` };
    return { outcome: "released", finalizedTimestamp: finalizedTs };
  }
  return { outcome: "live", facilitator: fac.status };
}

/** Nonces the payer used on chain that this store has never recorded (rollback/backup evidence). */
export async function reconcileUnknown(
  chain: ChainEvidence,
  token: Address,
  payer: Address,
  known: PaymentRecord[],
): Promise<Hex[]> {
  if (!chain.listUsedNonces) return [];
  const have = new Set(known.map((k) => lower(k.nonce)));
  return (await chain.listUsedNonces(token, payer)).filter((n) => !have.has(lower(n)));
}

const AUTH_STATE = parseAbi([
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
]);
const AUTH_USED = parseAbiItem(
  "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)",
);
/** ChainEvidence over a viem public client (read-only). */
export function viemChainEvidence(client: PublicClient): ChainEvidence {
  return {
    async latestTimestamp() {
      return (await client.getBlock({ blockTag: "latest" })).timestamp;
    },
    async finalizedTimestamp() {
      return (await client.getBlock({ blockTag: "finalized" })).timestamp;
    },
    async authorizationUsedAtFinalized(token, payer, nonce) {
      return client.readContract({
        address: getAddress(token),
        abi: AUTH_STATE,
        functionName: "authorizationState",
        args: [getAddress(payer), nonce],
        blockTag: "finalized",
      });
    },
    async findAuthorizationUsedTx(token, payer, nonce) {
      const logs = await client.getLogs({
        address: getAddress(token),
        event: AUTH_USED,
        args: { authorizer: getAddress(payer), nonce },
        fromBlock: 0n,
        toBlock: "latest",
      });
      return logs[0]?.transactionHash ?? null;
    },
    async getReceipt(tx) {
      try {
        const r = await client.getTransactionReceipt({ hash: tx });
        return {
          success: r.status === "success",
          logs: r.logs.map((l) => ({
            address: l.address,
            topics: [...l.topics] as Hex[],
            data: l.data,
          })),
        };
      } catch {
        return null;
      }
    },
    async listUsedNonces(token, payer) {
      const logs = await client.getLogs({
        address: getAddress(token),
        event: AUTH_USED,
        args: { authorizer: getAddress(payer) },
        fromBlock: 0n,
        toBlock: "latest",
      });
      return logs.map((l) => l.args.nonce as Hex);
    },
  };
}
