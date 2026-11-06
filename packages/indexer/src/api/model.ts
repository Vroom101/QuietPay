import { keccak256, stringToHex, type Hex } from "viem";
import { z } from "zod";

export const Address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
export const Hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
export const BlockNumber = z.number().int().nonnegative().safe();
export const ScopeSchema = z.object({
  chainId: z.number().int().positive().safe(),
  router: Address,
  token: Address,
  deploymentBlock: BlockNumber,
  confirmations: z.number().int().min(1).max(10000),
  agent: z.object({ payTo: Address, merchantId: Hash }).optional(),
});
export type Scope = z.infer<typeof ScopeSchema>;
export interface Block {
  number: number;
  hash: Hex;
  timestamp: number;
}
interface Location {
  blockNumber: number;
  blockHash: Hex;
  txHash: Hex;
  logIndex: number;
}
export type ChainEvent = Location &
  (
    | {
        type: "Paid";
        merchantId: Hex;
        orderId: Hex;
        payer: Hex;
        payout: Hex;
        value: string;
        fee: string;
        relayer: Hex;
      }
    | {
        type: "Refunded";
        merchantId: Hex;
        orderId: Hex;
        payer: Hex;
        amount: string;
        totalRefunded: string;
        refundIndex: string;
      }
    | {
        type: "MerchantRegistered";
        merchantId: Hex;
        payout: Hex;
        refundSigner: Hex;
        maxRelayFee: string;
      }
    | { type: "PayoutChanged"; merchantId: Hex; payout: Hex }
    | {
        type: "AgentTransfer";
        merchantId: Hex;
        payer: Hex;
        payTo: Hex;
        amount: string;
      }
  );
export interface RecordedEvent {
  event: ChainEvent;
  timestamp: number;
}
export interface ChainReader {
  getChainId(): Promise<number>;
  getHead(): Promise<number>;
  getBlock(number: number): Promise<Block>;
  getEvents(fromBlock: number, toBlock: number): Promise<ChainEvent[]>;
}
export function normalizeScope(value: Scope): Scope {
  const s = ScopeSchema.parse(value);
  if (s.agent?.payTo.toLowerCase() === s.router.toLowerCase())
    throw new Error("Agent payTo must not be the router");
  return {
    ...s,
    router: s.router.toLowerCase(),
    token: s.token.toLowerCase(),
    ...(s.agent
      ? {
          agent: {
            payTo: s.agent.payTo.toLowerCase(),
            merchantId: s.agent.merchantId.toLowerCase(),
          },
        }
      : {}),
  };
}
export const eventKey = (e: Pick<ChainEvent, "txHash" | "logIndex">) =>
  `${e.txHash.toLowerCase()}:${e.logIndex}`;
export function canonicalEvent(e: ChainEvent): ChainEvent {
  // Explicit key sorting makes persistence, export and RPC reconstruction hash identically.
  return Object.fromEntries(
    Object.entries(e)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => [
        k,
        typeof v === "string" && v.startsWith("0x") ? v.toLowerCase() : v,
      ]),
  ) as ChainEvent;
}
export function uniqueEvents(events: RecordedEvent[]): RecordedEvent[] {
  const map = new Map<string, RecordedEvent>();
  for (const item of events) {
    const canonical = {
      event: canonicalEvent(item.event),
      timestamp: item.timestamp,
    };
    const key = eventKey(item.event),
      existing = map.get(key);
    if (existing && JSON.stringify(existing) !== JSON.stringify(canonical))
      throw new Error(`Conflicting log ${key}`);
    map.set(key, canonical);
  }
  return [...map.values()].sort(
    (a, b) =>
      a.event.blockNumber - b.event.blockNumber ||
      a.event.logIndex - b.event.logIndex ||
      a.event.txHash.localeCompare(b.event.txHash),
  );
}
export function eventSetHash(events: RecordedEvent[]): Hex {
  return keccak256(stringToHex(JSON.stringify(uniqueEvents(events))));
}
export const ExportMetaSchema = ScopeSchema.extend({
  schemaVersion: z.literal(1),
  layout: z.literal("event-journal-v1"),
  fromBlock: BlockNumber,
  toBlock: BlockNumber,
  toBlockHash: Hash,
  eventSetHash: Hash,
  generatedAt: z.string().datetime(),
  merchantId: Hash.optional(),
})
  .strict()
  .refine(
    (m) => m.fromBlock >= m.deploymentBlock && m.toBlock >= m.fromBlock,
    "Invalid export range",
  );
export type ExportMeta = z.infer<typeof ExportMetaSchema>;
export interface ExportBundle {
  csv: string;
  meta: ExportMeta;
}
export function selectedEvents(
  events: RecordedEvent[],
  from: number,
  to: number,
  merchantId?: string,
) {
  return uniqueEvents(events).filter(
    ({ event: e }) =>
      e.blockNumber >= from &&
      e.blockNumber <= to &&
      (!merchantId || e.merchantId.toLowerCase() === merchantId.toLowerCase()),
  );
}
